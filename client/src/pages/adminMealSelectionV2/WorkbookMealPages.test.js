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


function breakfastWithExtras() {
  return { id: 'breakfast-extra', name: 'Breakfast with topping', category: 'OATS', temperature: 'COLD', components: [
    component('base', 'Breakfast', 'Oats', ['Gluten']),
    { ...component('nuts', 'Extra sauce / topping', 'Nut topping', ['Nuts'], 'Serve separately'), attachedComponentId: 'base' },
    component('sauce', 'Extra sauce / topping', 'Yoghurt sauce', ['Dairy']),
  ] };
}

test('renaming an existing breakfast retains editable extras and all dietary exclusions', () => {
  const meal = breakfastWithExtras();
  const before = JSON.parse(JSON.stringify(meal));
  const onSave = render(meal);
  expect([...host.querySelectorAll('input')].some(input => input.value === 'Nut topping')).toBe(true);
  expect([...host.querySelectorAll('input')].some(input => input.value === 'Yoghurt sauce')).toBe(true);
  setInput(inputFor('Meal name'), 'Renamed breakfast');
  click('Save preview draft');
  expect(onSave).toHaveBeenCalledTimes(1);
  const saved = onSave.mock.calls[0][0];
  expect(saved.components.filter(c => c.type === 'Extra sauce / topping')).toEqual(before.components.filter(c => c.type === 'Extra sauce / topping'));
  expect(saved.components.flatMap(c => c.exclusions)).toEqual(['Gluten', 'Nuts', 'Dairy']);
  expect(meal).toEqual(before);
});

test('an existing breakfast extra is removed only by its explicit remove control', () => {
  const onSave = render(breakfastWithExtras());
  const remove = host.querySelector('button[aria-label="Remove Extra sauce / topping component"]');
  expect(remove).not.toBeNull();
  act(() => remove.click());
  click('Save preview draft');
  const saved = onSave.mock.calls[0][0];
  expect(saved.components.some(c => c.id === 'nuts')).toBe(false);
  expect(saved.components.find(c => c.id === 'sauce')).toMatchObject({ name: 'Yoghurt sauce', exclusions: ['Dairy'] });
});


function breakfastWithSecondSauce() {
  return { id: 'breakfast-sauce-2', name: 'Breakfast with second sauce', category: "MAIN B'FAST", temperature: 'WARM', components: [
    component('base', 'Breakfast', 'Eggs', ['Egg']),
    { ...component('second-sauce', 'Sauce 2', 'Nut sauce', ['Nuts', 'Dairy'], 'Serve sauce separately'), sourceCell: 'J12', originalText: 'Original sauce instructions' },
  ] };
}

test('renaming breakfast migrates Sauce 2 to an editable extra without losing its data', () => {
  const meal = breakfastWithSecondSauce(); const before = JSON.parse(JSON.stringify(meal));
  const onSave = render(meal);
  expect([...host.querySelectorAll('input')].some(input => input.value === 'Nut sauce')).toBe(true);
  expect(host.textContent).toContain('Nuts');
  setInput(inputFor('Meal name'), 'Renamed breakfast');
  click('Save preview draft');
  expect(onSave).toHaveBeenCalledTimes(1);
  const saved = onSave.mock.calls[0][0];
  expect(saved.components.find(c => c.id === 'second-sauce')).toEqual({ ...before.components[1], type: 'Extra sauce / topping' });
  expect(saved.isSaladBase).toBe(false);
  expect(meal).toEqual(before);
});

test('a migrated breakfast Sauce 2 remains editable and can be explicitly removed', () => {
  const onSave = render(breakfastWithSecondSauce());
  const sauceInput = [...host.querySelectorAll('input')].find(input => input.value === 'Nut sauce');
  expect(sauceInput).toBeDefined();
  setInput(sauceInput, 'Updated sauce');
  click('Save preview draft');
  expect(onSave.mock.calls[0][0].components.find(c => c.id === 'second-sauce')).toMatchObject({ name: 'Updated sauce', exclusions: ['Nuts', 'Dairy'], notes: 'Serve sauce separately' });
  act(() => host.querySelector('button[aria-label="Remove Extra sauce / topping component"]').click());
  click('Save preview draft');
  expect(onSave.mock.calls[1][0].components.some(c => c.id === 'second-sauce')).toBe(false);
});


const chooseKind = kind => act(() => [...host.querySelectorAll('input[type="radio"]')].find(input => input.closest('label').textContent === kind).click());

test('Main to Breakfast to Main restores unsaved salad and sauce data', () => {
  const onSave = render(importedSalad());
  setInput(inputFor('Salad name'), 'Edited salad draft');
  chooseKind('Breakfast'); chooseKind('Main meal');
  expect(inputFor('Salad name').value).toBe('Edited salad draft');
  click('Save preview draft');
  expect(onSave).toHaveBeenCalledTimes(1);
  const saved = onSave.mock.calls[0][0];
  expect(saved.isSaladBase).toBe(true);
  expect(saved.components.find(c => c.id === 'vegetable')).toMatchObject({ type: 'Salad', name: 'Edited salad draft', exclusions: ['Coriander', 'Nuts'], notes: 'Original salad notes' });
  expect(saved.components.find(c => c.id === 'dressing')).toMatchObject({ type: 'Sauce 2', name: 'Original dressing', exclusions: ['Soy'] });
});

test('saving after switching a salad meal to Breakfast keeps converted components editable', () => {
  const onSave = render(importedSalad());
  chooseKind('Breakfast');
  expect([...host.querySelectorAll('input')].some(input => input.value === 'Original salad')).toBe(true);
  expect([...host.querySelectorAll('input')].some(input => input.value === 'Original dressing')).toBe(true);
  click('Save preview draft');
  expect(onSave).toHaveBeenCalledTimes(1);
  const saved = onSave.mock.calls[0][0];
  expect(saved.components.find(c => c.id === 'vegetable')).toMatchObject({ type: 'Vegetable', name: 'Original salad', exclusions: ['Coriander', 'Nuts'], notes: 'Original salad notes' });
  expect(saved.components.find(c => c.id === 'dressing')).toMatchObject({ type: 'Extra sauce / topping', name: 'Original dressing', exclusions: ['Soy'] });
  expect(saved.isSaladBase).toBe(false);
});

test('each kind retains its own edits across repeated switches', () => {
  const onSave = render(importedSalad());
  chooseKind('Breakfast');
  const salad = [...host.querySelectorAll('input')].find(input => input.value === 'Original salad');
  expect(salad).toBeDefined(); setInput(salad, 'Breakfast vegetables');
  chooseKind('Main meal'); expect(inputFor('Salad name').value).toBe('Original salad');
  chooseKind('Breakfast');
  expect([...host.querySelectorAll('input')].some(input => input.value === 'Breakfast vegetables')).toBe(true);
  click('Save preview draft');
  expect(onSave.mock.calls[0][0].components.find(c => c.id === 'vegetable')).toMatchObject({ name: 'Breakfast vegetables', exclusions: ['Coriander', 'Nuts'] });
});

test('switching through Snack restores the complete main-meal draft', () => {
  const onSave = render(importedSalad());
  chooseKind('Snack'); chooseKind('Breakfast'); chooseKind('Main meal');
  expect(inputFor('Salad name').value).toBe('Original salad');
  click('Save preview draft');
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0][0].components.map(c => c.id).sort()).toEqual(['dressing', 'protein', 'vegetable']);
  expect(onSave.mock.calls[0][0].components.flatMap(c => c.exclusions).sort()).toEqual(['Coriander', 'Dairy', 'Nuts', 'Soy']);
});


test('exclusion labels use title case while saving retains every original phrase', () => {
  const flags = ['RAW ONION', 'DRAGON FRUIT', 'glUTen', 'ALL NUTS'];
  const meal = { id: 'display-format', name: 'Display test', category: 'MAIN CHX', components: [component('p', 'Protein', 'Chicken', flags)] };
  const onSave = render(meal);
  for (const label of ['Raw Onion', 'Dragon Fruit', 'Gluten', 'All Nuts']) expect(host.textContent).toContain(label);
  expect(host.textContent).not.toContain('RAW ONION'); expect(host.textContent).not.toContain('DRAGON FRUIT');
  click('Save preview draft');
  expect(onSave.mock.calls[0][0].components[0].exclusions).toEqual(flags);
  act(() => host.querySelector('button[aria-label="Remove exclusion Raw Onion"]').click());
  click('Save preview draft');
  expect(onSave.mock.calls[1][0].components[0].exclusions).toEqual(flags.slice(1));
});
