import { mealType, mealFormat, cycleSlots } from '../pages/adminMealSelectionV2/workbookMeals';

export const CYCLE_CATALOGUE_KEY = 'matter-admin-v2:workbook-cycle-v2';
export const CYCLE_BOARD_KEY = 'matter-admin-v2:weekly-board-v1';
const fail = message => { throw new Error(message); };
const clone = value => JSON.parse(JSON.stringify(value));
const dateKey = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Choose valid menu start and end dates first.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('Choose valid menu start and end dates first.');
  return date;
};
const nameOf = (meal, types) => meal.components.filter(c => types.includes(c.type)).map(c => c.name).filter(Boolean).join(' + ');
const seed = meals => {
  const board = Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => []));
  meals.forEach(meal => {
    const days = meal.day === 'DAY 6 & 7' ? [5, 6] : /^DAY ([1-5])$/.test(meal.day) ? [Number(meal.day.slice(-1)) - 1] : [];
    const slot = mealFormat(meal) === 'Breakfast' ? 0 : mealFormat(meal) === 'Snack' ? 3 : 1;
    days.forEach(day => board[day][slot].push({ mealId: meal.id, isMatterCore: false }));
  });
  return board;
};

// A one-way copy into a NEW dated menu. Neither browser cycle store is written.
export function importCycleMenu({ catalogue, boards, week, startDate, endDate }) {
  if (!['Week 1', 'Week 2'].includes(week)) fail('Choose Week 1 or Week 2.');
  const start = dateKey(startDate), end = dateKey(endDate);
  if (start.getUTCDay() !== 1 || end.getTime() !== start.getTime() + 6 * 86400000) fail('Choose a Monday start date and the following Sunday end date for cycle import.');
  if (!catalogue || !Array.isArray(catalogue.meals)) fail('No saved Cycle Menu meals found in this browser tab.');
  const byId = new Map();
  catalogue.meals.forEach(meal => {
    if (!meal || typeof meal.id !== 'string' || !meal.id || byId.has(meal.id)) fail('Cycle Menu has missing or duplicate meal IDs.');
    byId.set(meal.id, meal);
  });
  if (boards === null || typeof boards !== 'object' || Array.isArray(boards)) fail('The saved Cycle Menu board could not be read.');
  const key = `Main menu:${week}`;
  const board = Object.prototype.hasOwnProperty.call(boards, key) ? boards[key] : week === 'Week 1' ? seed(catalogue.meals) : null;
  if (!Array.isArray(board) || board.length !== 7) fail('Save the selected Cycle Menu week before importing it.');
  let total = 0;
  const days = board.map((groups, day) => {
    if (!Array.isArray(groups) || groups.length !== 4 || groups.some(group => !Array.isArray(group))) fail('The saved Cycle Menu day has an invalid slot layout.');
    const date = new Date(start.getTime() + day * 86400000).toISOString().slice(0, 10);
    const seenIds = new Set(), seenNames = new Set();
    const items = groups.flatMap((entries, slot) => entries.map(entry => {
      const meal = byId.get(entry?.mealId);
      if (!meal) fail(`A meal on cycle day ${day + 1} is missing from the meal library. Reload or repair the cycle before importing.`);
      if (!cycleSlots(meal).includes(slot)) fail(`${meal.name || meal.id} is in an incompatible cycle slot.`);
      if (typeof meal.name !== 'string' || !meal.name.trim() || !Array.isArray(meal.components) || !meal.components.length) fail(`Complete ${meal.name || meal.id} before importing.`);
      if (meal.components.some(c => !c || typeof c.name !== 'string' || !c.name.trim() || !Array.isArray(c.exclusions) || c.exclusions.some(flag => typeof flag !== 'string' || !flag.trim()))) fail(`Check the component names and exclusions for ${meal.name}.`);
      const type = slot === 0 ? 'breakfast' : slot === 3 ? 'snack' : 'main';
      const protein = type === 'main' ? mealType(meal).toLowerCase() : '';
      if (type === 'main' && !['chicken', 'beef', 'fish'].includes(protein)) fail(`Choose Chicken, Beef or Fish for ${meal.name} before importing.`);
      const dishKey = `${type}:${meal.name.trim().toLowerCase()}`;
      if (seenIds.has(meal.id) || seenNames.has(dishKey)) fail(`${meal.name} appears more than once on ${date}; remove duplicate assignments before importing.`);
      seenIds.add(meal.id); seenNames.add(dishKey); total++;
      return {
        mealName: meal.name.trim(), mealType: type,
        proteinSource: nameOf(meal, ['Protein', 'Breakfast', 'Snack']), carbs: nameOf(meal, ['Carb']),
        veg: nameOf(meal, ['Vegetable', 'Salad']), sauce: nameOf(meal, ['Sauce']), garnish: nameOf(meal, ['Garnish']),
        category: meal.temperature || '', portionType: protein, rotationCategory: slot === 1 ? 'main' : slot === 2 ? 'sub' : '',
        usedForCorePlan: type === 'main' && !!entry.isMatterCore,
        ingredients: '', intolerances: '', allergens: '',
        portionIngredients: [], carbIngredients: [], vegIngredients: [], sauceIngredients: [],
        cycleMeal: clone({ ...meal, cycleSource: { workbook: catalogue.source || '', week, day: day + 1 } }),
      };
    }));
    return { date, items };
  });
  if (!total) fail('The selected Cycle Menu week is empty.');
  return days;
}

export function importSavedCycleMenu({ storage, ...options }) {
  let catalogue, boards;
  try {
    catalogue = JSON.parse(storage.getItem(CYCLE_CATALOGUE_KEY));
    boards = JSON.parse(storage.getItem(CYCLE_BOARD_KEY) || '{}');
  } catch { fail('The saved Cycle Menu data could not be read in this browser tab.'); }
  return importCycleMenu({ catalogue, boards, ...options });
}
