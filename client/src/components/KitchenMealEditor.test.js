import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import KitchenMealEditor from './KitchenMealEditor';
import api from '../utils/api';
import { assertKitchenRosterCovered } from '../lib/kitchenSnapshot';
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let node, root;
const date = '2026-11-16';
const entry = { matterCustomerId: '42', customerName: 'Mansoor', selectedMeals: [] };
const props = () => ({ entry, menuId: 'menu', date, canEdit: true, onChanged: jest.fn() });
const button = text => [...node.querySelectorAll('button')].find(item => item.textContent.includes(text));
beforeEach(() => {
  jest.clearAllMocks(); node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
  api.get.mockResolvedValue({ data: { success: true, data: { token: 'version', canEdit: true,
    meals: [{ _id: 'saved', mealName: 'Seafood', quantity: 2 }], choices: [{ id: 'chicken', name: 'Chicken', mealType: 'main', conflicts: [] }] } } });
  api.post.mockResolvedValue({ data: { success: true, data: { message: 'Saved' } } });
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
test('delete needs explicit confirmation naming customer, date and quantity; opening or cancelling never deletes', async () => {
  const p = props();
  await act(async () => root.render(<KitchenMealEditor {...p} intent={{ action: 'delete', mealId: 'saved' }} />));
  expect(node.textContent).toContain('Mansoor'); expect(node.textContent).toContain(date); expect(node.textContent).toContain('Delete 1 portion(s) of Seafood?');
  expect(api.post).not.toHaveBeenCalled();
  await act(async () => button('Cancel').click());
  expect(api.post).not.toHaveBeenCalled();
  await act(async () => root.render(<KitchenMealEditor {...p} intent={{ action: 'delete', mealId: 'saved' }} />));
  await act(async () => { node.querySelector('[aria-label="Portions"]').value = '2'; node.querySelector('[aria-label="Portions"]').dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Confirm delete').click());
  expect(api.post).toHaveBeenCalledWith('/menus/menu/kitchen-customers/42/meal-editor', expect.objectContaining({ action: 'delete', quantity: 2, token: 'version' }), { timeout: 30000 });
  expect(p.onChanged).toHaveBeenCalledTimes(1);
});
test('cutoff disables additions and changes while history and explicit restore remain available', async () => {
  const p = props(); p.canEdit = false; p.entry = { ...entry, kitchenAutoHolds: [{ date }] };
  api.get.mockResolvedValueOnce({ data: { success: true, data: { entries: [{ _id: 'log', actorName: 'Ahmed Ali', action: 'delete', date, summary: 'Deleted Seafood', createdAt: '2026-11-13T10:00:00Z' }], next: null } } });
  await act(async () => root.render(<KitchenMealEditor {...p} />));
  expect(button('Add meal').disabled).toBe(true);
  expect(node.textContent).toContain('Deleted portions stay deleted');
  await act(async () => button('Meal activity log').click());
  expect(node.textContent).toContain('Ahmed Ali'); expect(node.textContent).toContain('(Dubai)');
  await act(async () => button('Restore automatic assignment').click());
  await act(async () => button('Confirm restore').click());
  expect(api.post.mock.calls[0][1].action).toBe('restore');
});
test('after cutoff, only the flagged meal and same-type replacement can be saved', async () => {
  const p = { ...props(), canEdit: false };
  api.get.mockResolvedValueOnce({ data: { success: true, data: { token: 'version', canEdit: false,
    allergyReplacementMealIds: ['saved'], meals: [
      { _id: 'saved', mealName: 'Peanut chicken', mealType: 'main', quantity: 2 },
      { _id: 'other', mealName: 'Other meal', mealType: 'main' },
    ], choices: [
      { id: 'chicken', name: 'Lemon chicken', mealType: 'main', conflicts: [] },
      { id: 'peanuts', name: 'Peanut salad', mealType: 'main', conflicts: [], allergyConflicts: ['Peanuts'] },
      { id: 'oats', name: 'Oats', mealType: 'breakfast', conflicts: [] },
    ] } } });
  await act(async () => root.render(<KitchenMealEditor {...p} intent={{ action: 'change', mealId: 'saved' }} />));
  expect(button('Add meal').disabled).toBe(true);
  expect([...node.querySelector('[aria-label="Current meal"]').options].map(item => item.value)).toEqual(['', 'saved']);
  const choices = node.querySelector('[aria-label="New dish"]');
  expect([...choices.options].map(item => item.value)).toEqual(['', 'chicken', 'peanuts']);
  expect(choices.querySelector('[value="peanuts"]').disabled).toBe(true);
  expect(button('Confirm meal change').disabled).toBe(true);
  await act(async () => { choices.value = 'chicken'; choices.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Confirm meal change').click());
  expect(api.post).toHaveBeenCalledWith('/menus/menu/kitchen-customers/42/meal-editor',
    expect.objectContaining({ action: 'change', mealId: 'saved', menuItemId: 'chicken' }), { timeout: 30000 });
  expect(p.onChanged).toHaveBeenCalledTimes(1);
});
test('stale errors are shown without reporting success, and a late response cannot open another customer’s editor', async () => {
  const p = props();
  await act(async () => root.render(<KitchenMealEditor {...p} intent={{ action: 'delete', mealId: 'saved' }} />));
  api.post.mockRejectedValueOnce(new Error('Selections changed; reload'));
  await act(async () => button('Confirm delete').click());
  expect(node.querySelector('[role="alert"]').textContent).toContain('Selections changed');
  expect(p.onChanged).not.toHaveBeenCalled();
  let release; api.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => root.render(<KitchenMealEditor {...p} intent={{ action: 'delete', mealId: 'saved' }} />));
  await act(async () => root.render(<KitchenMealEditor {...p} entry={{ ...entry, matterCustomerId: '43' }} />));
  await act(async () => release({ data: { success: true, data: { meals: [], choices: [], token: 'old' } } }));
  expect(node.querySelector('[role="dialog"]')).toBeNull();
});

test('incomplete held dates block the shared paper/counting export path with a restore instruction', () => {
  const roster = [{ customer_id: '42', meal_frequency: 2 }];
  const rows = [{ matterCustomerId: '42', selectedMeals: [{ date, mealType: 'main' }], kitchenAutoHolds: [{ date }] }];
  expect(() => assertKitchenRosterCovered(rows, roster, date)).toThrow('Restore automatic assignment');
  rows[0].selectedMeals[0].quantity = 2;
  expect(() => assertKitchenRosterCovered(rows, roster, date)).not.toThrow();
});
