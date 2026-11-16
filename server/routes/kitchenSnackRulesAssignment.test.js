import test from 'node:test';
import assert from 'node:assert/strict';
import Menu from '../models/WeeklyMenu.js';
import Item from '../models/MenuItem.js';
import Record from '../models/MenuSelectionRecord.js';
import Snack from '../models/KitchenSnackPreset.js';
import Rule from '../models/KitchenSnackRule.js';
import { runAssignSnacks, runAssignMatterCoreMeals } from './menus.js';

const query = value => ({ select() { return this; }, sort() { return this; }, lean() { return this; },
  exec: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
for (const core of [false, true]) for (const allBlocked of [false, true]) {
  test(`${core ? 'Core' : 'standard'} snack top-up: ${allBlocked ? 'no eligible snack reports a customer-specific failure' : 'blocked first pool falls back and fills both snack slots'}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T08:00:00Z') });
    const date = '2026-11-06';
    const row = { _id: 'record', matterCustomerId: '42', email: 'internal@example.invalid', skippedDays: [], selectedMeals: [{ date, mealType: 'main', mealName: 'Chosen chicken' }] };
    const before = JSON.stringify(row);
    const nutrition = { customer_id: '42', customer_email: 'website@example.invalid', customer_name: 'Fixture', subscription_id: 'renewed-sub',
      meal_frequency: 1, breakfast_included: false, snacks_per_day: 2, exclusions: [], active_delivery_dates: [date], double_delivery_dates: [], plan_name: core ? 'Matter Core' : 'Custom' };
    t.mock.method(Menu, 'findById', () => query({ meals: [], snackOptionsByDate: { [date]: {
      first: [{ name: 'Muffin (W/ SOY)', C: 15, P: 10, F: 6 }], second: [{ name: 'Oats', C: 20, P: 12, F: 6 }],
    } } }));
    t.mock.method(Item, 'find', () => query([]));
    t.mock.method(Record, 'find', () => query([row]));
    t.mock.method(Record, 'findOne', () => query(row));
    t.mock.method(Snack, 'findOne', () => query({ presetsByName: { muffin: { C: 15, P: 10, F: 6 }, oats: { C: 20, P: 12, F: 6 } } }));
    const ruleRead = t.mock.method(Rule, 'find', filter => {
      assert.deepEqual(filter, { _id: { $in: ['42'] } });
      return query([{ _id: '42', blockedSnacks: [{ key: 'muffin' }, ...(allBlocked ? [{ key: 'oats' }] : [])] }]);
    });
    const writes = [];
    t.mock.method(Record, 'updateOne', async (_, update) => { writes.push(...update.$push.selectedMeals.$each); return { modifiedCount: 1 }; });
    t.mock.method(Record, 'findOneAndUpdate', async (_, update) => { writes.push(...update.$push.selectedMeals.$each); return {}; });
    const result = core
      ? await runAssignMatterCoreMeals('menu', date, [{ email: row.email }], { snackOnly: true, matterInputs: [nutrition] })
      : await runAssignSnacks('menu', { date }, { matterInputs: [nutrition] });
    assert.equal(ruleRead.mock.callCount(), 1);
    assert.equal(writes.length, allBlocked ? 0 : 2);
    assert(writes.every(meal => meal.mealName === 'Oats' && meal.isAutoAssigned === true));
    assert.equal(JSON.stringify(row), before);
    assert.equal(result.data.snackRuleFailures.length > 0, allBlocked);
    if (allBlocked) assert.equal(result.data.snackRuleFailures[0].name, 'Fixture');
  });
}
