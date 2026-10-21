import test from 'node:test';
import assert from 'node:assert/strict';
import WeeklyMenu from '../models/WeeklyMenu.js';
import MenuItem from '../models/MenuItem.js';
import Customer from '../models/Customer.js';
import Record from '../models/MenuSelectionRecord.js';
import matter from '../services/matterApiService.js';
import { runAssignMainMeals, runAssignSnacks } from './menus.js';
import { preparationHasFailures } from '../services/kitchenPreparation.js';

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
  Record.findOneAndUpdate = async (_filter, update) => { writes++; record.selectedMeals.push(...update.$push.selectedMeals.$each); };
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
