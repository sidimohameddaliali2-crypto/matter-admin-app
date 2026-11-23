import { getDateKey } from '../lib/kitchenData';
import { addAssignedGrams, bufferedPortionPieces, countingMealName, decimalGramNumber, isAbsentKitchenComponent, isLargeKitchenBreakfast, kitchenComponentNames, kitchenMealCategory, kitchenMealGroupKey, kitchenMealNameKey, kitchenPortionQuantity, kitchenRecipeForMeal } from './kitchenCountingComponents';

const clean = value => String(value || '').trim();
const recipeComponentNames = (item, types) => [...new Set((item.cycleMeal?.components || [])
  .filter(component => types.includes(component.type)).map(component => clean(component.name)).filter(Boolean))];
const resolvedGarnishes = item => {
  const names = recipeComponentNames(item, ['Garnish']);
  return names.length ? names : [item.garnish];
};
const resolvedSauces = (meal, item) => {
  if (meal.sauceChoice) return [meal.sauceChoice];
  const names = recipeComponentNames(item, ['Sauce']);
  return names.length ? names : [item.sauce];
};
const breakfastBase = name => clean(name).replace(/\s*\(LARGE\)$/i, '');
const breakfastComponentKey = name => clean(name).split(/\s+\+\s+/).map(part => kitchenMealNameKey(breakfastBase(part))).sort().join(' + ');
const dietaryKey = values => [...new Set((Array.isArray(values) ? values : []).map(kitchenMealNameKey).filter(Boolean))].sort();
const ingredientKey = value => typeof value === 'string' ? kitchenMealNameKey(value) : value || [];
const compatibleBreakfastChoices = (first, second) => Object.keys(first).every(kind => !first[kind] || !second[kind] || first[kind] === second[kind]);
const compatibleBreakfasts = (first, second) => {
  const firstRecipe = first.cycleMeal || {}, secondRecipe = second.cycleMeal || {};
  if (JSON.stringify(ingredientKey(first.ingredients)) !== JSON.stringify(ingredientKey(second.ingredients))) return false;
  if (JSON.stringify(ingredientKey(firstRecipe.ingredients)) !== JSON.stringify(ingredientKey(secondRecipe.ingredients))) return false;
  const garnishes = item => resolvedGarnishes(item).filter(value => !isAbsentKitchenComponent(value)).map(breakfastComponentKey).sort();
  if (JSON.stringify(garnishes(first)) !== JSON.stringify(garnishes(second))) return false;
  if (['notes', 'temperature'].some(field => kitchenMealNameKey(firstRecipe[field]) !== kitchenMealNameKey(secondRecipe[field]))) return false;
  if (JSON.stringify(dietaryKey(firstRecipe.allergens)) !== JSON.stringify(dietaryKey(secondRecipe.allergens))) return false;
  if (firstRecipe.components?.length && secondRecipe.components?.length) {
    const componentSignature = recipe => JSON.stringify(recipe.components.map(component => {
      const type = ['Breakfast', 'Protein', 'Portion'].includes(component.type) ? 'Portion' : component.type;
      return JSON.stringify([type, breakfastComponentKey(component.name), kitchenMealNameKey(component.notes),
        kitchenMealNameKey(component.adaptation), kitchenMealNameKey(component.replacement),
        dietaryKey(component.exclusions), dietaryKey(component.allergens), ingredientKey(component.ingredients)]);
    }).sort());
    if (componentSignature(firstRecipe) !== componentSignature(secondRecipe)) return false;
  } else if (firstRecipe.id && secondRecipe.id && firstRecipe.id !== secondRecipe.id) {
    return false;
  }
  return ['proteinSource', 'carbs', 'veg', 'sauce', 'garnish'].every(field => !first[field] || !second[field]
    || breakfastComponentKey(first[field]) === breakfastComponentKey(second[field]));
};

// Excel stores only 15 significant digits. Preserve the integer from the
// exact decimal calculation for the exported inputs, including after Excel
// recalculates. If staff change the inputs, calculate from their new values.
const pieceFormula = (gramsCell, pieceCell, component, pieces, bufferCell) => {
  const bufferChecks = bufferCell ? `,${bufferCell}=5%` : '';
  const multiplier = bufferCell ? `*(1+${bufferCell})` : '';
  return `IF(AND(${gramsCell}=${component.baseGrams},${pieceCell}=${component.gramsPerPiece}${bufferChecks}),${pieces},ROUNDUP(${gramsCell}${multiplier}/${pieceCell},0))`;
};

// Production planning only. Never resize saved portions or change macros.
export function buildCookingLog(entries, date, catalog) {
  const blocks = new Map();
  const portionWeights = new WeakMap();
  const portions = entries.flatMap(entry => (entry.selectedMeals || []).filter(meal => getDateKey(meal.date) === date).map(meal => {
    const item = kitchenRecipeForMeal(meal, catalog), category = kitchenMealCategory(meal);
    const rawName = countingMealName(meal, item);
    const name = category === 'breakfast' ? breakfastBase(rawName) : rawName;
    const breakfastUnit = category === 'breakfast' ? kitchenPortionQuantity(category, '', item, date, name, meal).unit : undefined;
    const names = kitchenComponentNames(meal, catalog, item);
    const sauces = resolvedSauces(meal, item);
    const sauceChoices = sauces.filter(value => !isAbsentKitchenComponent(value)).map(breakfastComponentKey).sort();
    const choices = category === 'breakfast' ? {
      ...Object.fromEntries(Object.entries(names).map(([kind, value]) => [kind, !value || value === 'Component not recorded' ? '' : breakfastComponentKey(value)])),
      sauce: sauceChoices.length || item._id && !item.unresolved || sauces.some(Boolean) ? JSON.stringify(sauceChoices) : '',
    } : null;
    const largeBreakfast = isLargeKitchenBreakfast(meal, item);
    const itemKey = kitchenMealGroupKey(meal, item, name);
    const key = category === 'breakfast' ? JSON.stringify([largeBreakfast ? 'large' : 'regular', itemKey, breakfastUnit, choices]) : itemKey;
    return { entry, meal, item, category, name, names, sauces, choices, breakfastUnit, largeBreakfast, key };
  }));
  const regularBreakfasts = new Map();
  for (const portion of portions) {
    if (portion.category !== 'breakfast' || portion.largeBreakfast || portion.item.ambiguous) continue;
    const label = kitchenMealNameKey(portion.name);
    if (!regularBreakfasts.has(label)) regularBreakfasts.set(label, new Map());
    regularBreakfasts.get(label).set(portion.key, portion);
  }
  for (const { entry, meal, item, category, name, names, sauces, choices, breakfastUnit, largeBreakfast, key: itemKey } of portions) {
    const regularKeys = largeBreakfast && !item.ambiguous ? [...(regularBreakfasts.get(kitchenMealNameKey(name)) || [])]
      .filter(([, regular]) => regular.breakfastUnit === breakfastUnit
        && compatibleBreakfasts(regular.item, item) && compatibleBreakfastChoices(regular.choices, choices)) : [];
    const key = regularKeys.length === 1 ? regularKeys[0][0] : itemKey;
    const recipe = item.cycleMeal?.components || [];
    const qty = Number(meal.quantity) || 1;
    if (!blocks.has(key)) blocks.set(key, { name, category, count: 0,
      label: item.cycleMeal?.category || [item.rotationCategory, item.portionType].filter(Boolean).join(' ') || category,
      components: [] });
    const block = blocks.get(key); block.count += qty;
    if (largeBreakfast) block.largeCount = (block.largeCount || 0) + qty;
    const add = (kind, label, unit, value, gramsPerPiece, assignedGrams) => {
      if (isAbsentKitchenComponent(label)) return;
      const componentName = category === 'breakfast' && kind === 'Portion'
        ? clean(label).split(/\s+\+\s+/).map(breakfastBase).join(' + ') : clean(label);
      const componentKey = category === 'breakfast' ? breakfastComponentKey : kitchenMealNameKey;
      const existing = block.components.find(row => row.kind === kind && componentKey(row.name) === componentKey(componentName) && row.unit === unit
        && row.gramsPerPiece === gramsPerPiece);
      const component = existing || { kind, name: componentName, unit, base: 0 };
      component.base += value;
      if (gramsPerPiece) {
        component.gramsPerPiece = gramsPerPiece;
        portionWeights.set(component, addAssignedGrams(portionWeights.get(component), assignedGrams, qty));
      }
      if (largeBreakfast && kind === 'Portion') component.largeCount = (component.largeCount || 0) + qty;
      if (!existing) block.components.push(component);
    };
    const pcs = category === 'breakfast' || category === 'snack';
    const portion = kitchenPortionQuantity(category, names.protein, item, date, name, meal);
    const salad = item.cycleMeal?.isSaladBase === true || recipe.some(component => component.type === 'Salad');
    const coreMain = category === 'meal' && (meal.flags?.matterCorePlan === true || clean(entry.planName).toLowerCase() === 'matter core');
    for (const [kind, label] of [['protein', 'Portion'], ['carb', 'Carb'], ['veg', salad ? 'Salad base' : 'Veg']]) {
      // Core main meals have no vegetable portion. A PCS salad must not be
      // inferred from recipe metadata when the calculated portion excludes it.
      if (kind === 'veg' && salad && coreMain) continue;
      // Breakfast/snack recipes often have no separate carb or veg component.
      if (pcs && kind !== 'protein' && names[kind] === 'Component not recorded') continue;
      const unit = kind === 'protein' ? portion.unit : pcs || (kind === 'veg' && salad) ? 'PCS' : 'KG';
      const gramsPerPiece = kind === 'protein' && category === 'meal' && unit === 'PCS' ? portion.gramsPerPiece : undefined;
      // Sum the calculator's gram quantities first. Converting each 150g
      // portion to 0.15kg before adding can turn 3000g into 2.999999999999999kg.
      const componentName = (kind === 'protein' && portion.componentName) || names[kind];
      const grams = Number(meal[`${kind}Weight`]) || 0;
      add(label, componentName, unit, unit === 'PCS' && !gramsPerPiece ? qty : grams * qty, gramsPerPiece, grams);
    }
    for (const sauce of sauces) add('Sauce', sauce, 'PCS', qty);
    for (const sauce of recipeComponentNames(item, ['Sauce 2'])) add('Sauce 2 / dressing', sauce, 'PCS', qty);
    for (const topping of recipeComponentNames(item, ['Extra sauce / topping'])) add('Extra sauce / topping', topping, 'PCS', qty);
    for (const name of resolvedGarnishes(item)) add('Garnish', name, 'PCS', qty);
  }
  for (const block of blocks.values()) {
    for (const component of block.components) {
      if (component.gramsPerPiece) {
        const grams = portionWeights.get(component);
        component.baseGrams = decimalGramNumber(grams);
        component.base = bufferedPortionPieces(grams, component.gramsPerPiece, 0);
        component.bufferedPieces = bufferedPortionPieces(grams, component.gramsPerPiece);
      } else if (component.unit === 'KG') {
        component.baseGrams = component.base;
        component.base = component.baseGrams / 1000;
      }
    }
    if (!block.largeCount) continue;
    block.name = `${block.name} (${block.largeCount}-LARGE)`;
    for (const component of block.components) {
      if (component.largeCount) component.name = `${component.name} (${component.largeCount}-LARGE)`;
    }
  }
  const order = { meal: 0, breakfast: 1, snack: 2 };
  return [...blocks.values()].sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.name.localeCompare(b.name));
}

export function cookingLogWorkbook(XLSX, blocks, date) {
  const workbook = XLSX.utils.book_new(), sheet = {}, base = {};
  const colors = { navy: '101D35', lime: 'D8F88E', cream: 'F3EEE8', line: 'D8CEC3', white: 'FFFFFF' };
  const common = { font: { name: 'Arial', sz: 10 }, alignment: { vertical: 'center', wrapText: true },
    border: Object.fromEntries(['top', 'bottom', 'left', 'right'].map(edge => [edge, { style: 'thin', color: { rgb: colors.line } }])) };
  const put = (ws, r, c, value, style = {}, formula) => {
    const address = XLSX.utils.encode_cell({ r, c });
    ws[address] = { t: typeof value === 'number' ? 'n' : 's', v: value, s: { ...common, ...style }, ...(formula ? { f: formula, t: 'n' } : {}) };
    return address;
  };
  const title = { font: { name: 'Arial', sz: 14, bold: true, color: { rgb: colors.white } }, fill: { fgColor: { rgb: colors.navy } } };
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }, { s: { r: 2, c: 0 }, e: { r: 2, c: 10 } }];
  put(sheet, 0, 0, `MATTER — COOKING & EOD — ${date}`, title);
  put(sheet, 1, 0, 'Weight buffer'); put(sheet, 1, 1, 0.05, { numFmt: '0%' });
  sheet.B2.c = [{ a: 'MATTER', t: 'Owner rule: add 5% to main protein, carb and vegetable weights. Main portions configured as PCS also receive this buffer on source grams before rounding up using grams per piece. Other PCS components receive no buffer.' }];
  put(sheet, 2, 0, 'Fill yellow ACTUAL COOK and EOD cells in the listed unit. INITIAL includes the weight buffer, including main portion grams before conversion to PCS. Base quantities are on Calculation.');
  const headers = ['MEAL / COMPONENT', 'INITIAL', 'ACTUAL COOK', 'EOD', 'UNIT'];
  const baseHeaders = ['Meal', 'Type', 'Component', 'Unit', 'Base quantity', 'Source weight (g)', 'Grams per piece'];
  baseHeaders.forEach((value, c) => put(base, 0, c, value, title));
  let row = 4, baseRow = 1;
  sheet['!rows'] = [{ hpt: 28 }, { hpt: 22 }, { hpt: 34 }];
  for (let index = 0; index < blocks.length; index += 2) {
    const pair = blocks.slice(index, index + 2), height = Math.max(...pair.map(block => block.components.length)) + 4;
    pair.forEach((block, side) => {
      const col = side * 6;
      for (let offset = 0; offset < 2; offset++) sheet['!merges'].push({ s: { r: row + offset, c: col }, e: { r: row + offset, c: col + 4 } });
      put(sheet, row, col, block.name, { ...title, font: { ...title.font, sz: 11 } });
      put(sheet, row + 1, col, `${block.label.toUpperCase()} — ${block.count} portions`, { fill: { fgColor: { rgb: colors.cream } } });
      headers.forEach((value, c) => put(sheet, row + 2, col + c, value, { font: { name: 'Arial', sz: 10, bold: true }, fill: { fgColor: { rgb: colors.lime } } }));
      block.components.forEach((component, offset) => {
        const r = row + 3 + offset;
        [block.name, component.kind, component.name, component.unit, component.base,
          component.baseGrams ?? '', component.gramsPerPiece ?? ''].forEach((value, c) => put(base, baseRow, c, value, c === 4 ? { numFmt: component.unit === 'PCS' ? '0' : '0.000' } : {}));
        if (component.gramsPerPiece) {
          base[`E${baseRow + 1}`].f = pieceFormula(`F${baseRow + 1}`, `G${baseRow + 1}`, component, component.base);
          base[`G${baseRow + 1}`].c = [{ a: 'MATTER', t: `Portion rule: ${component.gramsPerPiece}g per piece. INITIAL adds the buffer to total assigned grams, divides by grams per piece and rounds up once. Base quantity here is before the buffer.` }];
        }
        const ref = `Calculation!E${baseRow + 1}`, kg = component.unit === 'KG';
        // Calculate tenths of buffered kg directly from source grams using
        // the exact 105/10000 ratio; do not apply a fixed floating-point epsilon.
        const bufferedKg = kg && block.category === 'meal';
        const pieceWeight = component.gramsPerPiece;
        const initial = pieceWeight ? (component.bufferedPieces ?? bufferedPortionPieces(component.baseGrams, pieceWeight))
          : bufferedKg ? Math.round((component.baseGrams ?? component.base * 1000) * 105 / 10000) / 10 : component.base;
        put(sheet, r, col, `${component.kind}: ${component.name}`);
        const formula = pieceWeight ? pieceFormula(`Calculation!F${baseRow + 1}`, `Calculation!G${baseRow + 1}`, component, initial, '$B$2')
          : bufferedKg ? `ROUND(${ref}*(1+$B$2),1)` : ref;
        put(sheet, r, col + 1, initial, { numFmt: bufferedKg ? '0.0' : kg ? '0.0##' : '0' }, formula);
        for (const c of [col + 2, col + 3]) put(sheet, r, c, '', { fill: { fgColor: { rgb: 'FFF2CC' } }, numFmt: kg ? '0.000' : '0' });
        put(sheet, r, col + 4, component.unit);
        sheet['!rows'][r] = { hpt: 36 }; baseRow++;
      });
      sheet['!rows'][row] = { hpt: 35 };
    });
    row += height + 1;
  }
  sheet['!ref'] = `A1:K${Math.max(row, 4)}`;
  sheet['!cols'] = [36, 12, 14, 12, 8, 3, 36, 12, 14, 12, 8].map(wch => ({ wch }));
  base['!ref'] = `A1:G${baseRow}`; base['!cols'] = [40, 24, 55, 10, 16, 20, 18].map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(workbook, sheet, 'Cooking & EOD');
  XLSX.utils.book_append_sheet(workbook, base, 'Calculation');
  const instructions = XLSX.utils.aoa_to_sheet([
    ['How to use'],
    ['Fill only ACTUAL COOK and EOD on the Cooking & EOD sheet, using the listed unit.'],
    ['INITIAL is the required quantity: assigned main protein/carb/veg weights plus the buffer in B2, rounded to one decimal place for KG.'],
    ['Sauces, dressing, garnish and salad bases use pieces without a buffer. Breakfasts and snacks also have no buffer and use pieces by default.'],
    ['Main portions configured as PCS: sum assigned grams, add 5%, divide by the saved grams per piece and round up once (250g × 1.05 ÷ 50 = 6 PCS). Calculation shows source grams and the conversion.'],
    ['Duplicate meal portions each need their own sauce/garnish piece. Breakfast totals combine normal and Large portions; (21-LARGE) means 21 of the total are Large.'],
    ['Calculation contains the unbuffered source quantities. Changing this workbook does not update customer selections.'],
    ['Example only — not included in cooking counts'],
    ['Component', 'INITIAL', 'ACTUAL COOK', 'EOD', 'UNIT'],
    ['Chicken portion', 10.5, 11, 0.5, 'KG'],
    ['Sauce cup', 20, 20, 2, 'PCS'],
  ]);
  for (const address of Object.keys(instructions).filter(key => !key.startsWith('!'))) instructions[address].s = common;
  instructions['!cols'] = [{ wch: 95 }, ...Array.from({ length: 4 }, () => ({ wch: 15 }))];
  XLSX.utils.book_append_sheet(workbook, instructions, 'Instructions');
  workbook.Workbook = { CalcPr: { calcMode: 'auto' } };
  return workbook;
}
