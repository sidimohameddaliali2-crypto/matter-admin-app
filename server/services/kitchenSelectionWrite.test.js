import test from 'node:test';
import assert from 'node:assert/strict';
import Record from '../models/MenuSelectionRecord.js';
import { appendKitchenMeals, matchSavedKitchenInputs } from './kitchenSelectionWrite.js';

test('the optimistic filter retains a legacy meal in its original BSON shape', () => {
  const selectedMeals = [{ date: new Date('2026-10-22'), mealName: 'Customer choice', mealType: 'main' }];
  const conditions = Record.find({ $expr: matchSavedKitchenInputs({ selectedMeals }) }).cast(Record);
  assert.deepEqual(conditions.$expr.$and[0].$eq[1].$literal, selectedMeals);
  assert.equal(Object.hasOwn(conditions.$expr.$and[0].$eq[1].$literal[0], 'isUpcomingPlan'), false);
});

test('concurrent assignments append once and preserve a newer customer selection', async (t) => {
  let meals = [];
  const snapshot = { _id: 'record', selectedMeals: [] };
  t.mock.method(Record, 'findOneAndUpdate', async (filter, update) => {
    if (JSON.stringify(filter.$expr.$and[0].$eq[1].$literal) !== JSON.stringify(meals)) return null;
    meals = [...meals, ...update.$push.selectedMeals.$each];
    return { selectedMeals: meals };
  });
  const update = { $push: { selectedMeals: { $each: [{ mealName: 'Chicken' }, { mealName: 'Beef' }] } } };
  const results = await Promise.allSettled([appendKitchenMeals('menu', 'person', snapshot, update), appendKitchenMeals('menu', 'person', snapshot, update)]);
  assert.equal(meals.length, 2);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  meals = [{ mealName: 'Customer choice' }];
  await assert.rejects(appendKitchenMeals('menu', 'person', snapshot, update), { code: 'KITCHEN_PREPARATION_BUSY' });
  assert.deepEqual(meals, [{ mealName: 'Customer choice' }]);
});
