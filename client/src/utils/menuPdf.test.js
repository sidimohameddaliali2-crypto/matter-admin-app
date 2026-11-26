import { TextEncoder, TextDecoder } from 'util';
import { drawMenuPdf, menuPdfSections, selectionPdfSections } from './menuPdf';

global.TextEncoder ??= TextEncoder;
global.TextDecoder ??= TextDecoder;
const { jsPDF } = require('jspdf');

const menu = { meals: [{ date: '2099-11-02', mealType: 'main', items: [
  { _id: 'chicken', mealName: 'Chicken bowl', carbs: 'Rice', veg: 'Vegetables', portionIngredients: [{ name: 'Private kitchen ingredient', visible: false }] },
] }, { date: '2099-11-02', mealType: 'breakfast', items: [{ _id: 'oats', mealName: 'Overnight oats' }] },
{ date: '2099-11-02', mealType: 'snack', items: [{ _id: 'snack', mealName: 'Kitchen-only snack' }] }] };

test('printed menu keeps the public courses and descriptions without leaking private ingredient tags', () => {
  const sections = menuPdfSections(menu);
  expect(sections[0].meals.map(meal => meal.name)).toEqual(['Chicken bowl', 'Overnight oats']);
  expect(sections[0].meals[0].description).toBe('Rice · Vegetables');
  expect(JSON.stringify(sections)).not.toContain('Private kitchen ingredient');
});

test('the design keeps declared allergens and explicit component choices in the printable description', () => {
  const dated = { meals: [{ date: '2099-11-02', mealType: 'main', items: [{ _id: 'dish', mealName: 'House bowl', allergens: ['Milk', 'Egg'], carbs: 'Rice' }] }] };
  expect(menuPdfSections(dated)[0].meals[0].description).toContain('Allergens: Milk, Egg');
  const customer = { selectedMeals: [{ date: '2099-11-02', mealType: 'main', menuItemId: 'dish', mealName: 'House bowl', proteinChoice: 'Beef', carbChoice: 'Quinoa' }] };
  expect(selectionPdfSections(customer, dated)[0].meals[0].description).toBe('Protein: Beef · Quinoa · Allergens: Milk, Egg');
});

test('selection PDF uses the dated recipe and keeps quantities, acknowledgements, assignment sources and pause outcomes', () => {
  const customer = { selectedMeals: [
    { date: '2099-11-02', menuItemId: 'chicken', mealName: 'Chicken bowl', mealType: 'main', quantity: 2, preferenceConflict: ['Dairy'] },
    { date: '2099-11-02', menuItemId: 'oats', mealName: 'Overnight oats', mealType: 'breakfast', isAutoAssigned: true, isUpcomingPlan: true },
    { date: '2099-11-03', mealName: 'Do not print a paused delivery' },
  ], skippedDays: [{ date: '2099-11-03', pauseStatus: 'success', resumeDate: '2099-11-10' }, { date: '2099-11-04', pauseStatus: 'failed' }] };
  const sections = selectionPdfSections(customer, menu);
  expect(sections[0].meals[0]).toMatchObject({ quantity: 2, description: 'Rice · Vegetables', notes: 'Selected · Exclusion acknowledged' });
  expect(sections[0].meals[1].notes).toBe('Auto assigned · Upcoming plan');
  expect(sections[1]).toMatchObject({ message: 'Paused — resume 2099-11-10', meals: [] });
  expect(sections[2].message).toBe('Pause not applied — contact customer service');
});

test('local calendar dates remain on the selected day instead of shifting to the preceding UTC date', () => {
  const sections = selectionPdfSections({ selectedMeals: [] }, { meals: [] }, [new Date(2099, 10, 2)]);
  expect(sections.map(day => day.date)).toEqual(['2099-11-02']);
});

test('both downloads use native PDF text, warm paper and the MATTER logo; identical weekends combine only when requested', () => {
  const meals = [{ name: 'Baja Fish', description: 'Sundried tomato pasta', type: 'main' }];
  const sections = [{ date: '2026-09-12', meals }, { date: '2026-09-13', meals }];
  const doc = new jsPDF(); const text = jest.spyOn(doc, 'text');
  const image = jest.spyOn(doc, 'addImage'); const fill = jest.spyOn(doc, 'setFillColor');
  drawMenuPdf(doc, { title: 'Weekly menu', sections, mergeWeekends: true });
  expect(text.mock.calls.flatMap(call => call[0])).toContain('THE WEEKEND — DAYS ONE & TWO');
  expect(fill).toHaveBeenCalledWith(239, 233, 227);
  expect(image).toHaveBeenCalledTimes(2); // Header/footer logos, not screenshots of meal cards.
  const individual = new jsPDF(); const individualText = jest.spyOn(individual, 'text');
  drawMenuPdf(individual, { title: 'Customer selections', sections });
  expect(individualText.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['DAY ONE — SATURDAY', 'DAY TWO — SUNDAY']));
});

test('long descriptions fit one page without losing text or running into the footer', () => {
  const doc = new jsPDF(); const text = jest.spyOn(doc, 'text');
  const description = `${'A detailed ingredient description with vegetables and sauce. '.repeat(900)} LAST_TOKEN_END`;
  drawMenuPdf(doc, { title: 'Long menu', sections: [{ date: '2099-11-02', meals: [{ name: 'A longer dish name with accompaniments', description, type: 'main' }] }] });
  expect(doc.getNumberOfPages()).toBe(1);
  expect(text.mock.calls.flatMap(call => call[0]).join(' ')).toContain('LAST_TOKEN_END');
  expect(text.mock.calls.map(call => call[0])).toContain('DAY ONE — MONDAY');
  expect(text.mock.calls.filter(call => call[2] !== 285.5).every(call => call[2] <= 267)).toBe(true);
});


test('a complete seven-day selection with three meals daily exports all 21 meals on one page', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${i + 16}`, mealType: 'main',
    items: Array.from({ length: 3 }, (_, j) => ({ _id: `${i}-${j}`, mealName: `Day ${i + 1} meal ${j + 1}`, description: 'Rice, vegetables and sauce' })) }));
  const customer = { selectedMeals: rows.flatMap(row => row.items.map(item => ({ date: row.date, mealType: 'main', menuItemId: item._id, mealName: item.mealName, quantity: 1 }))) };
  const sections = selectionPdfSections(customer, { meals: rows });
  expect(sections).toHaveLength(7);
  expect(sections.every(day => day.meals.length === 3)).toBe(true);
  const doc = new jsPDF(); const text = jest.spyOn(doc, 'text');
  drawMenuPdf(doc, { title: 'Customer selections', titleBold: true, customerName: 'Sample Customer', sections });
  expect(doc.getNumberOfPages()).toBe(1);
  const printed = text.mock.calls.flatMap(call => call[0]);
  for (const meal of customer.selectedMeals) expect(printed).toContain(meal.mealName);
  expect(printed).toContain('DAY SEVEN \u2014 SUNDAY');
  expect(text.mock.calls.filter(call => call[2] !== 285.5).every(call => call[2] <= 267)).toBe(true);
});
