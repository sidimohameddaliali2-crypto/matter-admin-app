import test from 'node:test';
import assert from 'node:assert/strict';
import WeeklyMenu from '../models/WeeklyMenu.js';
import MenuItem from '../models/MenuItem.js';
import Customer from '../models/Customer.js';
import Record from '../models/MenuSelectionRecord.js';
import matter from '../services/matterApiService.js';
import { runAssignMainMeals, runAssignSnacks } from './menus.js';

test('assignment fills only missing quantities, respects skips, and queries only this menu', async () => {
  const original = { menu: WeeklyMenu.findById, items: MenuItem.find, customers: Customer.find, record: Record.findOne, write: Record.findOneAndUpdate };
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
    Customer.find = original.customers; Record.findOne = original.record; Record.findOneAndUpdate = original.write;
  }
});

test('a saved quantity-two snack already covers a two-snack entitlement', async () => {
  const original = { menu: WeeklyMenu.findById, records: Record.find, customers: Customer.find, nutrition: matter.getSubscriptionNutritionByEmail };
  const date = '2026-10-20';
  WeeklyMenu.findById = () => ({ select() { return this; }, lean: async () => ({ snackOptionsByDate: {} }) });
  Record.find = async () => [{ email: 'fixture@example.invalid', selectedMeals: [{ date, mealType: 'snack', quantity: 2 }], skippedDays: [] }];
  Customer.find = () => ({ select() { return this; }, lean: async () => [] });
  matter.getSubscriptionNutritionByEmail = async () => ({ snacks_per_day: 2 });
  try {
    const result = await runAssignSnacks('menu', { date });
    assert.equal(result.data.assigned, 0);
    assert.equal(result.data.skippedNoOptions, 0);
  } finally {
    WeeklyMenu.findById = original.menu; Record.find = original.records;
    Customer.find = original.customers; matter.getSubscriptionNutritionByEmail = original.nutrition;
  }
});
