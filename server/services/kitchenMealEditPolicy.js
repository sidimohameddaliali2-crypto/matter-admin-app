import { kitchenSelectionWindow } from './kitchenSelectionDeadline.js';

export const dayHeld = (record, date) => (record?.kitchenAutoHolds || []).some(hold => hold.date === date);
export const assertMealEditsOpen = (menu, date, now = new Date()) => {
  const window = kitchenSelectionWindow(menu, date, now);
  if (window.canAutoAssign) throw Object.assign(new Error(`Meal editing is closed for ${date}. The menu cutoff has passed (${window.deadlineAt}).`),
    { statusCode: 409, code: 'KITCHEN_MEAL_EDIT_CLOSED' });
  return window;
};
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const key = value => String(value?._id || value || '');
export const planMealEdit = ({ record, action, mealId, quantity = 1, replacement, date, actor, now = new Date() }) => {
  if (!['add', 'change', 'delete', 'restore'].includes(action)) fail('Choose a valid meal action.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) fail('Choose between 1 and 20 portions.');
  const meals = record?.selectedMeals || [];
  let holds = record?.kitchenAutoHolds || [];
  const target = meals.find(meal => key(meal._id) === mealId && new Date(meal.date).toISOString().slice(0, 10) === date);
  if (['change', 'delete'].includes(action) && !target) fail('The saved meal no longer exists on this date. Reload before editing.');
  const count = target ? Math.max(1, Math.floor(Number(target.quantity) || 1)) : 0;
  if (target && quantity > count) fail('The requested quantity exceeds the saved meal portions.');
  if (['add', 'change'].includes(action) && !replacement) fail('Choose an eligible menu dish.');
  let selectedMeals = meals;
  if (action === 'delete' || action === 'change') selectedMeals = meals.flatMap(meal => meal !== target ? [meal]
    : count > quantity ? [{ ...meal, quantity: count - quantity }] : []);
  if (action === 'add' || action === 'change') selectedMeals = [...selectedMeals, { ...replacement, date: new Date(date), quantity,
    isAutoAssigned: false }];
  if (action === 'delete' && !dayHeld(record, date)) holds = [...holds, { date, at: now, actorId: actor.id, actorName: actor.name }];
  if (action === 'restore') holds = holds.filter(hold => hold.date !== date);
  const snapshot = meal => meal ? { mealId: key(meal._id), name: meal.mealName, mealType: meal.mealType, quantity } : null;
  const before = snapshot(target), after = snapshot(replacement);
  const summary = action === 'restore' ? 'Restored automatic assignment'
    : action === 'change' ? `Changed ${quantity} × ${target.mealName} to ${replacement.mealName}`
      : `${action === 'add' ? 'Added' : 'Deleted'} ${quantity} × ${action === 'add' ? replacement.mealName : target.mealName}`;
  return { selectedMeals, kitchenAutoHolds: holds, before, after, summary };
};
