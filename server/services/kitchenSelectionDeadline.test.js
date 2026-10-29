import test from 'node:test';
import assert from 'node:assert/strict';
import { kitchenSelectionWindow, assertKitchenSelectionClosed } from './kitchenSelectionDeadline.js';
import Menu from '../models/WeeklyMenu.js';
import Record from '../models/MenuSelectionRecord.js';
import Snapshot from '../models/KitchenProductionSnapshot.js';
import Breakfast from '../models/KitchenBreakfastPreset.js';
import Snack from '../models/KitchenSnackPreset.js';
import Archive from '../models/MenuSelectionArchive.js';
import matter from './matterApiService.js';
import { beginKitchenState } from './kitchenProductionSnapshot.js';
import { runAssignMainMeals, runAssignSnacks, runAssignMatterCoreMeals, runAutoPopulateMissing } from '../routes/menus.js';

const query = value => ({ select() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => value });
const boundaries = [
  ['2026-10-26', '2026-10-23T11:00:59.999Z'],
  ['2026-10-27', '2026-10-24T20:00:59.999Z'],
  ['2026-10-28', '2026-10-25T20:00:59.999Z'],
  ['2026-10-29', '2026-10-26T20:00:59.999Z'],
  ['2026-10-30', '2026-10-27T20:00:59.999Z'],
  ['2026-10-31', '2026-10-27T20:00:59.999Z'],
  ['2026-11-01', '2026-10-27T20:00:59.999Z'],
];
for (const [date, cutoff] of boundaries) test(`${date}: Dubai cutoff minute stays open, assignment starts immediately afterwards`, () => {
  assert.equal(kitchenSelectionWindow({}, date, cutoff).deadlineAt, cutoff);
  assert.throws(() => assertKitchenSelectionClosed({}, date, cutoff), { code: 'KITCHEN_SELECTION_OPEN' });
  assert.equal(assertKitchenSelectionClosed({}, date, new Date(Date.parse(cutoff) + 1)).canAutoAssign, true);
});

test('uses menu-specific rules and fails closed for invalid policy or dates', () => {
  const menu = { selectionDeadlines: [{ deliveryDay: 'Monday', daysBefore: 0, deadlineTime: '18:30' }] };
  assert.equal(kitchenSelectionWindow(menu, '2026-10-26', '2026-10-26T14:00:00Z').deadlineAt, '2026-10-26T14:30:59.999Z');
  assert.throws(() => kitchenSelectionWindow(menu, '2026-10-27'), { code: 'KITCHEN_DEADLINE_INVALID' });
  assert.throws(() => kitchenSelectionWindow({}, '2026-02-30'), { statusCode: 400 });
});

test('every direct assignment path rejects an open date before writes or Matter lookups', async t => {
  t.mock.method(Menu, 'findById', () => query({}));
  for (const method of ['updateOne', 'findOneAndUpdate', 'create']) t.mock.method(Record, method, () => assert.fail(`Forbidden ${method}`));
  t.mock.method(matter, 'getKitchenNutrition', () => assert.fail('No nutrition lookup needed'));
  t.mock.method(matter, 'findSubscriptionsWithDeliveryOnDate', () => assert.fail('No roster lookup needed'));
  const date = '2099-11-02';
  for (const action of [() => runAssignMainMeals('menu', date, []), () => runAssignMatterCoreMeals('menu', date, []),
    () => runAssignSnacks('menu', { date }), () => runAutoPopulateMissing('menu', date)]) {
    await assert.rejects(action, { statusCode: 409, code: 'KITCHEN_SELECTION_OPEN' });
  }
});

test('unscoped snacks preflight every selected date before assigning any customer', async t => {
  t.mock.method(Menu, 'findById', () => query({}));
  t.mock.method(Record, 'find', async () => [{ selectedMeals: [{ date: '2026-10-01', mealType: 'main' }, { date: '2099-11-02', mealType: 'main' }] }]);
  t.mock.method(Record, 'updateOne', () => assert.fail('Cannot partially assign closed dates'));
  t.mock.method(matter, 'getKitchenNutrition', () => assert.fail('Preflight before customer processing'));
  await assert.rejects(() => runAssignSnacks('menu'), { code: 'KITCHEN_SELECTION_OPEN' });
});

test('open preview preserves saved choices, adds transient missing rows, and never starts preparation', async t => {
  const saved = { email: 'chosen@example.invalid', matterCustomerId: '42', selectedMeals: [{ date: '2099-11-02', mealName: 'Chosen beef', quantity: 2 }] };
  const before = JSON.stringify(saved);
  t.mock.method(Menu, 'findById', () => query({}));
  t.mock.method(Record, 'find', () => query([saved]));
  t.mock.method(Archive, 'find', () => query([]));
  t.mock.method(Breakfast, 'findOne', () => query(null));
  t.mock.method(Snack, 'findOne', () => query(null));
  t.mock.method(matter, 'findSubscriptionsWithDeliveryOnDate', async () => [
    { customer_id: '42', subscription_id: 'renewed', email: saved.email },
    { customer_id: '43', subscription_id: 'missing', email: 'missing@example.invalid', name: 'Missing customer' },
  ]);
  t.mock.method(Snapshot, 'create', () => assert.fail('No job on open date'));
  for (const method of ['updateOne', 'findOneAndUpdate', 'create']) t.mock.method(Record, method, () => assert.fail('Preview is read only'));
  const result = await beginKitchenState('menu', '2099-11-02', () => assert.fail('No assignment callback'));
  assert.equal(result.state, 'selection-open');
  assert.equal(result.data.selectionWindow.canAutoAssign, false);
  assert.equal(result.data.data.kitchenSelections.length, 2);
  assert.equal(JSON.stringify(saved), before);
  assert.deepEqual(result.data.data.kitchenSelections[1].selectedMeals, []);
});
