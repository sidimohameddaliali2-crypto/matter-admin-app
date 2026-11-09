import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MealComposer } from './WorkbookMealPages';

jest.mock('react-router-dom', () => ({ Link: ({ children }) => <span>{children}</span> }), { virtual: true });

let host, root;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = meal => {
  const onSave = jest.fn();
  act(() => root.render(<MealComposer meal={meal} isNew={false} onSave={onSave}/>));
  return onSave;
};
const click = text => act(() => [...host.querySelectorAll('button')].find(button => button.textContent === text).click());
const inputFor = label => [...host.querySelectorAll('label')].find(item => item.textContent === label).querySelector('input');
const setInput = (input, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const component = (id, type, name, exclusions, notes = '') => ({ id, type, name, exclusions, notes, adaptation: 'Not reviewed' });

function importedSalad() {
  return { id: 'imported-salad', name: 'Imported salad meal', category: 'MAIN CHX', temperature: 'COLD', tags: 'SALAD BASE', components: [
    component('protein', 'Protein', 'Chicken', ['Dairy']),
    component('vegetable', 'Vegetable', 'Original salad', ['Coriander', 'Nuts'], 'Original salad notes'),
    component('dressing', 'Sauce 2', 'Original dressing', ['Soy']),
  ] };
}

test('an imported vegetable salad is visible and saves unchanged with its exclusions', () => {
  const meal = importedSalad(); const before = JSON.parse(JSON.stringify(meal));
  const onSave = render(meal);
  expect(inputFor('Salad name').value).toBe('Original salad');
  expect(host.textContent).toContain('Coriander');
  click('Save preview draft');
  expect(onSave).toHaveBeenCalledTimes(1);
  const saved = onSave.mock.calls[0][0];
  expect(saved.components.find(c => c.type === 'Salad')).toMatchObject({ id: 'vegetable', name: 'Original salad', exclusions: ['Coriander', 'Nuts'], notes: 'Original salad notes' });
  expect(saved.components.find(c => c.type === 'Sauce 2')).toMatchObject({ name: 'Original dressing', exclusions: ['Soy'], saladComponentId: 'vegetable' });
  expect(saved.components.some(c => c.type === 'Vegetable')).toBe(false);
  expect(meal).toEqual(before);
});

test('renaming an imported salad preserves its identity and exclusions', () => {
  const onSave = render(importedSalad());
  setInput(inputFor('Salad name'), 'Renamed salad');
  click('Save preview draft');
  expect(onSave.mock.calls[0][0].components.find(c => c.type === 'Salad')).toMatchObject({ id: 'vegetable', name: 'Renamed salad', exclusions: ['Coriander', 'Nuts'] });
});

test.each([true, false])('ordinary snack editing retains every component exclusion (has Snack rows: %s)', hasSnack => {
  const meal = { id: 'legacy-snack', name: 'Imported snack', category: 'SNACK 1', components: [
    component('first', hasSnack ? 'Snack' : 'Protein', 'Original item', ['Nuts']),
    component('sauce', 'Sauce', 'Sauce', ['Dairy']),
    component('garnish', 'Garnish', 'Garnish', ['Sesame', 'Nuts']),
    component('second', hasSnack ? 'Snack' : 'Carb', 'Second item', ['Egg']),
  ] };
  const onSave = render(meal);
  for (const flag of ['Nuts', 'Dairy', 'Sesame', 'Egg']) expect(host.textContent).toContain(flag);
  setInput(inputFor('Snack name'), 'Renamed snack'); click('Save preview draft');
  const saved = onSave.mock.calls[0][0];
  expect(saved.components).toHaveLength(1);
  expect(saved.components[0]).toMatchObject({ type: 'Snack', name: 'Renamed snack', exclusions: ['Nuts', 'Dairy', 'Sesame', 'Egg'] });
  expect(meal.components).toHaveLength(4);
});

test('deliberately removing a snack exclusion does not re-add it on save', () => {
  const onSave = render({ id: 'snack', name: 'Snack', category: 'SNACK 1', components: [component('item', 'Snack', 'Item', ['Nuts']), component('sauce', 'Sauce', 'Sauce', ['Dairy'])] });
  act(() => host.querySelector('button[aria-label="Remove exclusion Dairy"]').click());
  click('Save preview draft');
  expect(onSave.mock.calls[0][0].components[0].exclusions).toEqual(['Nuts']);
});
