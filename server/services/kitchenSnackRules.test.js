import test from 'node:test';
import assert from 'node:assert/strict';
import Rule from '../models/KitchenSnackRule.js';
import { loadSnackRules, saveSnackRule, annotateSnackRules } from './kitchenSnackRules.js';
import { snackCatalogue } from './kitchenSnackPolicy.js';
import { replacementSnackMeals } from './kitchenSnackReplacement.js';

const presets = { muffin: { snackName: 'Muffin', C: 15, P: 10, F: 6 }, oats: { snackName: 'Oats', C: 20, P: 12, F: 6 } };
const rule = { _id: '42', version: 1, blockedSnacks: [{ key: 'muffin', name: 'Muffin' }] };
test('rules use one batched permanent-ID lookup, independent of subscriptions and duplicate internal records', async t => {
  const find = t.mock.method(Rule, 'find', filter => { assert.deepEqual(filter, { _id: { $in: ['42', '43'] } }); return { lean: async () => [rule] }; });
  const result = await loadSnackRules(['42', '42', '43']);
  assert.equal(result.get('42'), rule);
  assert.equal(find.mock.callCount(), 1);
});
test('save validates catalogue names, records an audit, and rejects stale versions and concurrent creates', async t => {
  t.mock.method(Rule, 'findById', () => ({ lean: async () => rule }));
  let update;
  t.mock.method(Rule, 'findOneAndUpdate', (filter, values) => { assert.deepEqual(filter, { _id: '42', version: 1 }); update = values; return { lean: async () => ({ ...rule, version: 2 }) }; });
  await assert.rejects(() => saveSnackRule({ customerId: '42', keys: ['Unknown'], version: 1, presets }), /Unknown or ambiguous/);
  await assert.rejects(() => saveSnackRule({ customerId: '42', keys: ['Muffin'], version: 0, presets }), /another session/);
  await saveSnackRule({ customerId: '42', keys: ['Oats'], version: 1, presets, actor: 'staff' });
  assert.deepEqual(update.$set.blockedSnacks, [{ key: 'oats', name: 'Oats' }]);
  assert.equal(update.$push.history.$each[0].actor, 'staff');
  assert.deepEqual(update.$push.history.$each[0].before, ['muffin']);
  t.mock.method(Rule, 'findById', () => ({ lean: async () => null }));
  t.mock.method(Rule, 'create', async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); });
  await assert.rejects(() => saveSnackRule({ customerId: '42', keys: [], version: 0, presets }), /another session/);
});
test('reads flag blocked auto snacks without changing choices or saved documents', () => {
  const rows = [{ matterCustomerId: '42', selectedMeals: [{ mealType: 'snack', mealName: 'Muffin', isAutoAssigned: true }] }];
  const before = JSON.stringify(rows);
  const result = annotateSnackRules(rows, new Map([['42', rule]]), snackCatalogue(presets));
  assert.match(result[0].selectedMeals[0].snackRuleConflict, /Blocked snack/);
  assert.equal(JSON.stringify(rows), before);
});
test('reviewed replacement preserves quantities, other dates, chosen snacks, mains and remarks', () => {
  const date = '2026-11-06';
  const meals = [{ date, mealType: 'main', mealName: 'Chicken', remark: 'veg' },
    { date, mealType: 'snack', mealName: 'Muffin', quantity: 2, isAutoAssigned: true },
    { date, mealType: 'snack', mealName: 'Muffin', isAutoAssigned: false },
    { date: '2026-11-07', mealType: 'snack', mealName: 'Muffin', isAutoAssigned: true }];
  const before = JSON.stringify(meals);
  const pools = { first: [{ name: 'Muffin' }], second: [{ name: 'Oats', C: 20, P: 12, F: 6 }] };
  const result = replacementSnackMeals(meals, date, rule, snackCatalogue(presets), pools, [], 3);
  assert.equal(result.replaced, 2);
  assert.equal(result.selectedMeals.filter(meal => meal.mealName === 'Oats').length, 2);
  assert.equal(result.selectedMeals[0], meals[0]);
  assert.equal(result.selectedMeals[3], meals[2]);
  assert.equal(result.selectedMeals[4], meals[3]);
  assert.equal(JSON.stringify(meals), before);
  assert.throws(() => replacementSnackMeals(meals, date, rule, snackCatalogue(presets), pools, ['Oats'], 3), /No eligible replacement/);
});
