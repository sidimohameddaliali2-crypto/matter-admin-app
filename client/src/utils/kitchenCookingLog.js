import { getDateKey } from '../lib/kitchenData';
import { countingMealName, kitchenComponentNames, kitchenRecipeForMeal } from './kitchenCountingComponents';

const clean = value => String(value || '').trim();
const absent = value => !clean(value) || /^(no|none|n\/a)(\s+(sauce|garnish))?$/i.test(clean(value));

// Production planning only. Never resize saved portions or change macros.
export function buildCookingLog(entries, date, catalog) {
  const blocks = new Map();
  for (const entry of entries) for (const meal of entry.selectedMeals || []) {
    if (getDateKey(meal.date) !== date) continue;
    const category = meal.category || (['breakfast', 'snack'].includes(meal.mealType) ? meal.mealType : 'meal');
    const name = countingMealName({ ...meal, category }), key = `${category}:${name}`;
    const item = kitchenRecipeForMeal(meal, catalog), names = kitchenComponentNames({ ...meal, category }, catalog);
    const recipe = item.cycleMeal?.components || [];
    const qty = Number(meal.quantity) || 1;
    if (!blocks.has(key)) blocks.set(key, { name, category, count: 0,
      label: item.cycleMeal?.category || [item.rotationCategory, item.portionType].filter(Boolean).join(' ') || category,
      components: [] });
    const block = blocks.get(key); block.count += qty;
    const add = (kind, label, unit, value) => {
      if (absent(label)) return;
      const existing = block.components.find(row => row.kind === kind && row.name.toLowerCase() === clean(label).toLowerCase() && row.unit === unit);
      if (existing) existing.base += value;
      else block.components.push({ kind, name: clean(label), unit, base: value });
    };
    const pcs = category === 'breakfast' || category === 'snack';
    const salad = item.cycleMeal?.isSaladBase === true || recipe.some(component => component.type === 'Salad');
    const coreMain = category === 'meal' && (meal.flags?.matterCorePlan === true || clean(entry.planName).toLowerCase() === 'matter core');
    for (const [kind, label] of [['protein', 'Portion'], ['carb', 'Carb'], ['veg', salad ? 'Salad base' : 'Veg']]) {
      // Core main meals have no vegetable portion. A PCS salad must not be
      // inferred from recipe metadata when the calculated portion excludes it.
      if (kind === 'veg' && salad && coreMain) continue;
      // Breakfast/snack recipes often have no separate carb or veg component.
      if (pcs && kind !== 'protein' && names[kind] === 'Component not recorded') continue;
      const unit = pcs || (kind === 'veg' && salad) ? 'PCS' : 'KG';
      add(label, names[kind], unit, unit === 'PCS' ? qty : (Number(meal[`${kind}Weight`]) || 0) * qty / 1000);
    }
    const componentNames = types => [...new Set(recipe.filter(component => types.includes(component.type)).map(component => clean(component.name)).filter(Boolean))];
    const sauces = meal.sauceChoice ? [meal.sauceChoice] : componentNames(['Sauce']);
    for (const sauce of sauces.length ? sauces : [item.sauce]) add('Sauce', sauce, 'PCS', qty);
    for (const sauce of componentNames(['Sauce 2'])) add('Sauce 2 / dressing', sauce, 'PCS', qty);
    for (const topping of componentNames(['Extra sauce / topping'])) add('Extra sauce / topping', topping, 'PCS', qty);
    const garnish = componentNames(['Garnish']);
    for (const name of garnish.length ? garnish : [item.garnish]) add('Garnish', name, 'PCS', qty);
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
  put(sheet, 1, 0, 'KG buffer'); put(sheet, 1, 1, 0.05, { numFmt: '0%' });
  sheet.B2.c = [{ a: 'MATTER', t: 'Owner rule: add 5% to main protein, carb and vegetable weights. PCS components receive no buffer.' }];
  put(sheet, 2, 0, 'Fill yellow ACTUAL COOK and EOD cells in the listed unit. INITIAL includes the KG buffer. PCS counts include duplicate portions. Base quantities are on Calculation.');
  const headers = ['MEAL / COMPONENT', 'INITIAL', 'ACTUAL COOK', 'EOD', 'UNIT'];
  const baseHeaders = ['Meal', 'Type', 'Component', 'Unit', 'Base quantity'];
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
        [block.name, component.kind, component.name, component.unit, component.base].forEach((value, c) => put(base, baseRow, c, value, c === 4 ? { numFmt: component.unit === 'PCS' ? '0' : '0.000' } : {}));
        const ref = `Calculation!E${baseRow + 1}`, kg = component.unit === 'KG';
        const initial = kg ? Math.round((component.base * 1.05 + Number.EPSILON) * 1000) / 1000 : component.base;
        put(sheet, r, col, `${component.kind}: ${component.name}`);
        put(sheet, r, col + 1, initial, { numFmt: kg ? '0.000' : '0' }, kg ? `ROUND(${ref}*(1+$B$2),3)` : ref);
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
  base['!ref'] = `A1:E${baseRow}`; base['!cols'] = [40, 24, 55, 10, 16].map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(workbook, sheet, 'Cooking & EOD');
  XLSX.utils.book_append_sheet(workbook, base, 'Calculation');
  const instructions = XLSX.utils.aoa_to_sheet([
    ['How to use'],
    ['Fill only ACTUAL COOK and EOD on the Cooking & EOD sheet, using the listed unit.'],
    ['INITIAL is the required quantity: assigned main protein/carb/veg weights plus the buffer in B2.'],
    ['Sauces, dressing, garnish, salad bases, breakfasts and snacks use pieces without a buffer.'],
    ['Duplicate meal portions each need their own sauce/garnish piece. Large breakfasts stay separate.'],
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
