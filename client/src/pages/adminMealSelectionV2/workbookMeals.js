export const CYCLE_DAYS = ['DAY 1', 'DAY 2', 'DAY 3', 'DAY 4', 'DAY 5', 'DAY 6 & 7'];
export const MEAL_CATEGORIES = ['MAIN FISH', 'MAIN CHX', 'MAIN BEEF', "MAIN B'FAST", 'SUB', 'CLASSIC', "SUB B'FAST", 'OATS', 'SNACK 1', 'SNACK 2', 'CHX SUB', 'FISH SUB', 'BEEF SUB'];
export const MEAL_TYPES = ['Chicken', 'Beef', 'Fish'];
export const MEAL_FORMATS = ['Main', 'Breakfast', 'Snack'];
export function mealFormat(meal) {
  if (meal.mealKind === 'Main meal') return 'Main';
  if (['Breakfast', 'Snack'].includes(meal.mealKind)) return meal.mealKind;
  if (MEAL_FORMATS.includes(meal.mealFormat)) return meal.mealFormat;
  if (/B'FAST|OATS/.test(meal.category || '')) return 'Breakfast';
  if (/SNACK/.test(meal.category || '')) return 'Snack';
  return 'Main';
}
export function mealType(meal) {
  if (MEAL_TYPES.includes(meal.mealType)) return meal.mealType;
  const category = meal.category || '';
  if (/\b(CHX|CHICKEN)\b/i.test(category)) return 'Chicken';
  if (/\bBEEF\b/i.test(category)) return 'Beef';
  if (/\bFISH\b/i.test(category)) return 'Fish';
  return '';
}
export const COMPONENT_TYPES = ['Protein', 'Breakfast', 'Snack', 'Carb', 'Vegetable', 'Sauce', 'Sauce 2', 'Extra sauce / topping', 'Garnish'];
const text = value => String(value ?? '').trim();

function records(rows, required, sheet) {
  const headerIndex = rows.findIndex(row => row.some(v => text(v) === 'Meal ID'));
  if (headerIndex < 0) throw new Error(`${sheet}: a Meal ID header row is required.`);
  const headers = rows[headerIndex].map(text);
  for (const name of required) if (!headers.includes(name)) throw new Error(`${sheet}: missing column “${name}”.`);
  return rows.slice(headerIndex + 1).filter(row => row.some(v => text(v))).map((row, index) => {
    const record = Object.fromEntries(headers.map((name, column) => [name, text(row[column])]));
    return { ...record, sourceRow: headerIndex + index + 2 };
  });
}

// Preserve the workbook's terminology and raw notes. In particular, do not
// interpret “NO DAIRY & GLUTEN FREE OPTION” as an approved dietary adaptation.
export function parseMealWorkbook(sheets) {
  if (!sheets.Meals || !sheets.Components) throw new Error('This import needs both Meals and Components sheets.');
  const rows = records(sheets.Meals, ['Meal ID', 'Day', 'Meal category', 'Temperature', 'Meal name', 'Protein / main item', 'Carb', 'Vegetable', 'Sauce', 'Garnish', 'Tags', 'Carb combined with veg', 'Preparation / option notes'], 'Meals');
  const componentRows = records(sheets.Components, ['Meal ID', 'Component type', 'Component name', 'Preparation / option notes'], 'Components');
  const ids = new Set();
  const meals = rows.map(row => {
    const id = row['Meal ID'];
    if (!id || ids.has(id)) throw new Error(`Meals row ${row.sourceRow}: missing or duplicate Meal ID “${id}”.`);
    if (!row['Meal name']) throw new Error(`Meals row ${row.sourceRow}: meal name is required.`);
    if (!CYCLE_DAYS.includes(row.Day)) throw new Error(`Meals row ${row.sourceRow}: unsupported cycle day “${row.Day}”.`);
    ids.add(id);
    return {
      id, name: row['Meal name'], day: row.Day, category: row['Meal category'], temperature: row.Temperature,
      tags: row.Tags, carbCombined: row['Carb combined with veg'], notes: row['Preparation / option notes'],
      sourceRows: row['Source rows'], workbookRow: row.sourceRow, status: 'Draft', components: [],
      absentSlots: row.Sauce === 'NO SAUCE' ? { Sauce: 'NO SAUCE' } : {},
    };
  });
  const byId = new Map(meals.map(meal => [meal.id, meal]));
  componentRows.forEach((row, index) => {
    const meal = byId.get(row['Meal ID']);
    if (!meal) throw new Error(`Components row ${row.sourceRow}: Meal ID “${row['Meal ID']}” was not found in Meals.`);
    if (!row['Component type'] || !row['Component name']) throw new Error(`Components row ${row.sourceRow}: component type and name are required.`);
    meal.components.push({
      id: `${meal.id}-component-${index}`, type: row['Component type'], name: row['Component name'],
      exclusions: Array.from({ length: 10 }, (_, i) => row[`Exclusion ${i + 1}`]).filter(Boolean),
      notes: row['Preparation / option notes'], sourceCell: row['Source cell'], originalText: row['Original component text'],
      adaptation: 'Not reviewed', relationship: 'Not reviewed', replacement: '',
    });
  });
  // Do not silently lose populated meal components if their detail row is absent.
  rows.forEach(row => {
    const meal = byId.get(row['Meal ID']);
    [['Protein / main item', ['Protein', 'Breakfast', 'Snack']], ['Carb', ['Carb']], ['Vegetable', ['Vegetable']], ['Sauce', ['Sauce']], ['Sauce 2', ['Sauce 2']], ['Garnish', ['Garnish']]].forEach(([column, types]) => {
      if (row[column] && !(column === 'Sauce' && row[column] === 'NO SAUCE') && !meal.components.some(c => types.includes(c.type) && c.name === row[column])) {
        throw new Error(`Meal ${meal.id}: “${column}” is missing a matching Components row.`);
      }
    });
  });
  return meals;
}

export function dietaryFlags(meal) {
  return [...new Set(meal.components.flatMap(component => component.exclusions))];
}

export function componentName(meal, type) {
  return meal.components.filter(c => (type === 'Main item' ? ['Protein', 'Breakfast', 'Snack'].includes(c.type) : type === 'Vegetable' ? ['Vegetable', 'Salad'].includes(c.type) : c.type === type)).map(c => c.name).join(' + ') || meal.absentSlots?.[type] || '—';
}

// A main meal can occupy either Main or Sub; that belongs to the assignment.
export function cycleSlots(meal) {
  return mealFormat(meal) === 'Breakfast' ? [0] : mealFormat(meal) === 'Snack' ? [3] : [1, 2];
}
