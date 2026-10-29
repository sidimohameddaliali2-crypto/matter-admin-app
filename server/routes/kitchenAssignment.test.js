import test from 'node:test';
import assert from 'node:assert/strict';
import WeeklyMenu from '../models/WeeklyMenu.js';
import MenuItem from '../models/MenuItem.js';
import Customer from '../models/Customer.js';
import Record from '../models/MenuSelectionRecord.js';
import Snack from '../models/KitchenSnackPreset.js';
import matter from '../services/matterApiService.js';
import { runAssignMainMeals, runAssignSnacks, runAssignMatterCoreMeals } from './menus.js';
import { preparationHasFailures } from '../services/kitchenPreparation.js';

for (const date of ['2026-10-31', '2026-11-01']) {
  test(`concurrent snack preparation shares one executed ingredient read on ${date}`, async t => {
    const records = Array.from({ length: 18 }, (_, index) => ({ _id: `record-${index}`, email: `customer-${index}@example.invalid`,
      matterCustomerId: String(index + 1), skippedDays: [], selectedMeals: [{ date, mealType: 'main', mealName: 'Saved customer choice' }] }));
    const inputs = records.map(record => ({ customer_id: record.matterCustomerId, snacks_per_day: 2, exclusions: ['Peanuts'], active_delivery_dates: [date] }));
    const query = value => ({ select() { return this; }, lean: async () => value });
    t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: [] }], snackOptionsByDate: {
      [date]: { first: [{ name: 'Peanut bite' }], second: [{ name: 'Safe bite' }] },
    } }));
    t.mock.method(Record, 'find', async () => records);
    t.mock.method(Snack, 'findOne', () => query({ presetsByName: { 'safe bite': { C: 15, P: 10, F: 6 } } }));
    t.mock.method(matter, 'getKitchenNutrition', () => assert.fail('Use supplied fixture nutrition; no network'));
    const makeQuery = MenuItem.find.bind(MenuItem);
    let executions = 0, reads = 0;
    t.mock.method(MenuItem, 'find', filter => {
      reads++;
      assert.equal(filter.itemDate.toISOString().slice(0, 10), date);
      const ingredientQuery = makeQuery(filter);
      // A real Mongoose Query is a single-execution thenable, unlike a Promise.
      let executed = false;
      t.mock.method(ingredientQuery, 'exec', async () => {
        if (executed) throw new Error('Query was already executed: MenuItem.find');
        executed = true; executions++;
        await new Promise(resolve => setImmediate(resolve));
        return [{ mealName: 'Peanut bite', ingredients: 'Peanuts' }, { mealName: 'Safe bite', ingredients: 'Oats' }];
      });
      return ingredientQuery;
    });
    const writes = [];
    t.mock.method(Record, 'updateOne', async (filter, update) => { writes.push({ filter, meals: update.$push.selectedMeals.$each }); return { modifiedCount: 1 }; });
    const before = JSON.stringify(records);
    const result = await runAssignSnacks('menu', { date }, { matterInputs: inputs });
    assert.equal(reads, 1);
    assert.equal(executions, 1);
    assert.equal(result.data.assigned, 36);
    assert.equal(writes.length, 18);
    assert(writes.every(write => write.meals.length === 2 && write.meals.every(meal => meal.mealName === 'Safe bite')));
    assert.equal(JSON.stringify(records), before, 'Existing customer choices stay intact');
  });
}

test('assignment fills only missing quantities, respects skips, and queries only this menu', async () => {
  const original = { menu: WeeklyMenu.findById, items: MenuItem.find, customers: Customer.find, record: Record.findOne, records: Record.find, nutrition: matter.getKitchenNutrition, write: Record.findOneAndUpdate };
  const date = '2026-10-20';
  const allowed = '507f1f77bcf86cd799439011';
  let record = { selectedMeals: [{ date, mealType: 'main', mealName: 'Existing', quantity: 2 }], skippedDays: [] };
  let writes = 0;
  WeeklyMenu.findById = () => ({ select() { return this; }, lean: async () => ({ meals: [{ items: [allowed] }], mainMealOptionsByDate: {}, breakfastOptionsByDate: {} }) });
  MenuItem.find = (filter) => {
    assert.deepEqual(filter._id, { $in: [allowed] }, 'date-wide items from overlapping menus must not be candidates');
    return { lean: async () => filter.mealType === 'breakfast' ? [] : [{ _id: allowed, mealName: 'Allowed', portionType: 'chicken', rotationCategory: 'main' }] };
  };
  Customer.find = () => ({ select() { return this; }, lean: async () => [] });
  Record.find = () => ({ select() { return this; }, lean: async () => [] });
  matter.getKitchenNutrition = async () => ({ customer_id: 'matter-person', customer_email: 'fixture@example.invalid', subscription_id: 'current', meal_frequency: 3, breakfast_included: false, snacks_per_day: 0, exclusions: [] });
  Record.findOne = () => ({ lean: async () => record });
  Record.findOneAndUpdate = async (_filter, update) => { writes++; record.selectedMeals.push(...update.$push.selectedMeals.$each); return record; };
  const customers = [{ email: 'fixture@example.invalid', mealFrequency: 3, breakfastIncluded: false }];
  try {
    const result = await runAssignMainMeals('menu', date, customers);
    assert.equal(result.data.assigned, 1);
    assert.equal(record.selectedMeals.reduce((sum, meal) => sum + meal.quantity, 0), 3);
    await runAssignMainMeals('menu', date, customers);
    assert.equal(writes, 1, 'retry cannot duplicate the third portion');
    record = { selectedMeals: [], skippedDays: [{ date }] };
    await runAssignMainMeals('menu', date, customers);
    assert.equal(writes, 1, 'an intentional skip cannot be auto-filled');
  } finally {
    WeeklyMenu.findById = original.menu; MenuItem.find = original.items;
    Customer.find = original.customers; Record.findOne = original.record; Record.findOneAndUpdate = original.write; Record.find = original.records; matter.getKitchenNutrition = original.nutrition;
  }
});

test('a saved quantity-two snack already covers a two-snack entitlement', async () => {
  const original = { menu: WeeklyMenu.findById, records: Record.find, customers: Customer.find, nutrition: matter.getKitchenNutrition };
  const date = '2026-10-20';
  WeeklyMenu.findById = () => ({ select() { return this; }, lean: async () => ({ snackOptionsByDate: {} }) });
  Record.find = async () => [{ email: 'fixture@example.invalid', selectedMeals: [{ date, mealType: 'snack', quantity: 2 }], skippedDays: [] }];
  Customer.find = () => ({ select() { return this; }, lean: async () => [] });
  matter.getKitchenNutrition = async () => ({ snacks_per_day: 2, customer_id: 'matter-person', customer_email: 'fixture@example.invalid' });
  try {
    const result = await runAssignSnacks('menu', { date });
    assert.equal(result.data.assigned, 0);
    assert.equal(result.data.skippedNoOptions, 0);
  } finally {
    WeeklyMenu.findById = original.menu; Record.find = original.records;
    Customer.find = original.customers; matter.getKitchenNutrition = original.nutrition;
  }
});

test('an unavailable standard-plan breakfast replaced by a main meal is fully covered', async (t) => {
  const date = '2026-10-23';
  const itemId = '507f1f77bcf86cd799439011';
  t.mock.method(WeeklyMenu, 'findById', () => ({ select() { return this; }, lean: async () => ({ meals: [{ items: [itemId] }] }) }));
  t.mock.method(MenuItem, 'find', (filter) => ({ lean: async () => filter.mealType === 'main'
    ? [{ _id: itemId, mealName: 'Main replacement', portionType: 'chicken', rotationCategory: 'main' }] : [] }));
  t.mock.method(Record, 'find', () => ({ select() { return this; }, lean: async () => [] }));
  t.mock.method(Record, 'findOne', () => ({ lean: async () => ({ selectedMeals: [] }) }));
  const writes = [];
  t.mock.method(Record, 'findOneAndUpdate', async (_filter, update) => writes.push(...update.$push.selectedMeals.$each));
  t.mock.method(matter, 'getKitchenNutrition', async () => ({ customer_id: '42', customer_email: 'fixture@example.invalid',
    subscription_id: 'current', meal_frequency: 2, breakfast_included: true, snacks_per_day: 0, exclusions: [] }));
  const result = await runAssignMainMeals('menu', date, [{ email: 'fixture@example.invalid' }]);
  assert.equal(writes.length, 2);
  assert.equal(result.data.substitutedBreakfastWithMain, 1);
  assert.equal(result.data.skippedBreakfastNoOption, 0);
  assert.equal(preparationHasFailures(result), false);
});

test('Core double-day top-up repeats a safe dish instead of leaving a slot empty or choosing excluded beef', async (t) => {
  const date = '2026-10-26', allowed = '507f1f77bcf86cd799439011';
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: [allowed] }], breakfastOptionsByDate: {}, snackOptionsByDate: {} }));
  t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'main' ? [
    { _id: allowed, mealName: 'Safe Chicken', portionType: 'chicken' },
    { _id: '507f1f77bcf86cd799439012', mealName: 'Excluded Beef', portionType: 'beef' },
  ] : []));
  t.mock.method(Record, 'find', () => query([]));
  t.mock.method(Record, 'findOne', () => query(null));
  const writes = [];
  t.mock.method(Record, 'findOneAndUpdate', async (_filter, update) => { writes.push(...update.$push.selectedMeals.$each); return {}; });
  t.mock.method(matter, 'getKitchenNutrition', async () => ({ customer_id: 'person', customer_email: 'core@example.invalid', subscription_id: 'current',
    meal_frequency: 2, breakfast_included: false, snacks_per_day: 0, exclusions: ['Beef'], active_delivery_dates: [date, '2026-10-28', '2026-10-30'] }));
  const result = await runAssignMatterCoreMeals('menu', date, [{ email: 'core@example.invalid' }], { snackOnly: true });
  assert.equal(result.data.assignedMainMeals, 4);
  assert.equal(writes.length, 4);
  assert(writes.every(meal => meal.mealName === 'Safe Chicken' && meal.exclusionConflict.length === 0));
});
