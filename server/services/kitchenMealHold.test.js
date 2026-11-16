import test from 'node:test';
import assert from 'node:assert/strict';
import { kitchenDateUnavailable } from './kitchenDeliveryEligibility.js';
import { appendKitchenMeals } from './kitchenSelectionWrite.js';
import { assertPreparedCoverage } from './kitchenCoverage.js';
import Record from '../models/MenuSelectionRecord.js';
import Menu from '../models/WeeklyMenu.js';
import Item from '../models/MenuItem.js';
import { runAssignMainMeals, runAssignSnacks, runAssignMatterCoreMeals } from '../routes/menus.js';

const date = '2026-11-16';
const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
test('standard, snack and Core auto-assignment all respect a persisted staff hold', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-14T08:00:00Z') });
  const record = { email: 'fixture@example.invalid', matterEmail: 'fixture@example.invalid', matterCustomerId: '42', selectedMeals: [], kitchenAutoHolds: [{ date }] };
  t.mock.method(Menu, 'findById', () => query({ meals: ['id'], mainMealOptionsByDate: { [date]: { mainMeals: [{ name: 'Chicken', type: 'chicken' }] } } }));
  t.mock.method(Item, 'find', () => query([]));
  t.mock.method(Record, 'find', () => query([record]));
  t.mock.method(Record, 'findOne', () => query(record));
  for (const method of ['updateOne', 'findOneAndUpdate', 'create']) t.mock.method(Record, method, () => assert.fail('Held date cannot be auto-filled'));
  const nutrition = { customer_id: '42', customer_name: 'Fixture', customer_email: record.email, subscription_id: 'sub',
    active_delivery_dates: [date], double_delivery_dates: [], meal_frequency: 2, breakfast_included: true, snacks_per_day: 0, exclusions: [] };
  assert.equal(await kitchenDateUnavailable(record, date, nutrition), true);
  await runAssignMainMeals('menu', date, [{ email: record.email }], { matterInputs: [nutrition] });
  await runAssignSnacks('menu', { date }, { matterInputs: [nutrition] });
  await runAssignMatterCoreMeals('menu', date, [{ email: record.email }], { matterInputs: [{ ...nutrition, plan_name: 'Matter Core' }] });
});
test('a hold arriving while an assignment is in flight is guarded in the atomic write filter', async t => {
  t.mock.method(Record, 'findOneAndUpdate', async filter => {
    assert.deepEqual(filter.$nor, [{ kitchenAutoHolds: { $elemMatch: { date: { $in: [date] } } } }]);
    return null;
  });
  await assert.rejects(() => appendKitchenMeals('menu', 'email', { selectedMeals: [] }, { $push: { selectedMeals: { $each: [{ date, mealName: 'Chicken' }] } } }), /Meals changed/);
});
test('held missing portions can be previewed but strict production coverage still rejects them', () => {
  const data = { kitchenRoster: [{ customer_id: '42', meal_frequency: 2 }],
    kitchenSelections: [{ matterCustomerId: '42', selectedMeals: [], kitchenAutoHolds: [{ date }] }] };
  assert.doesNotThrow(() => assertPreparedCoverage(data, date, { allowManualHolds: true }));
  assert.throws(() => assertPreparedCoverage(data, date), /needs 2 meal/);
});
