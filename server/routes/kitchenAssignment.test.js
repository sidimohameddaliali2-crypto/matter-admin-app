import test from 'node:test';
import assert from 'node:assert/strict';
import WeeklyMenu from '../models/WeeklyMenu.js';
import MenuItem from '../models/MenuItem.js';
import Customer from '../models/Customer.js';
import Record from '../models/MenuSelectionRecord.js';
import Breakfast from '../models/KitchenBreakfastPreset.js';
import Snack from '../models/KitchenSnackPreset.js';
import matter from '../services/matterApiService.js';
import { runAssignMainMeals, runAssignSnacks, runAssignMatterCoreMeals } from './menus.js';
import { preparationHasFailures } from '../services/kitchenPreparation.js';

for (const tagged of [false, true]) {
  test(`Core assignment ${tagged ? 'uses only dated tagged dishes' : 'leaves slots empty despite an old rotation when no dishes are tagged'}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T08:00:00Z') });
    const date = '2026-11-06';
    const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
    const id = '507f1f77bcf86cd799439011';
    t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: [id] }],
      matterCoreMealOptionsByDate: { [date]: [{ name: 'Old untagged fallback' }] }, snackOptionsByDate: {} }));
    t.mock.method(MenuItem, 'find', filter => {
      if (filter.mealType !== 'main') return query([]);
      assert.equal(filter.usedForCorePlan, true);
      assert.equal(filter.itemDate.toISOString().slice(0, 10), date);
      assert.deepEqual(filter._id.$in, [id]);
      return query(tagged ? [{ _id: id, mealName: 'Tagged Core chicken', usedForCorePlan: true, portionType: 'chicken' }] : []);
    });
    t.mock.method(Record, 'find', () => query([]));
    t.mock.method(Record, 'findOne', () => query(null));
    const writes = [];
    t.mock.method(Record, 'findOneAndUpdate', async (_, update) => { writes.push(...update.$push.selectedMeals.$each); return {}; });
    const nutrition = { customer_id: 'fixture', customer_email: 'core@example.invalid', subscription_id: 'sub', plan_name: 'Matter Core',
      meal_frequency: 2, breakfast_included: false, snacks_per_day: 0, exclusions: [], active_delivery_dates: [date], double_delivery_dates: [] };
    const result = await runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }], { matterInputs: [nutrition] });
    assert.equal(result.data.assignedMainMeals, tagged ? 2 : 0);
    assert.equal(result.data.skippedNoOption, tagged ? 0 : 2);
    assert.equal(writes.length, tagged ? 2 : 0);
    assert.ok(writes.every(meal => meal.menuItemId === id && meal.mealName === 'Tagged Core chicken'));
    assert.equal(preparationHasFailures({ assignedMatterCore: result.data }), !tagged);
  });
}

test('Wednesday Core starter tops up a second main, removes only an unentitled auto breakfast and is idempotent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T08:00:00Z') });
  const date = '2026-11-04', chicken = '507f1f77bcf86cd799439011', beef = '507f1f77bcf86cd799439012';
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  const chosen = { date, mealType: 'main', mealName: 'Customer chicken', quantity: 1, remark: 'veg', slotNumber: 0 };
  const record = { _id: 'record', matterCustomerId: 'fixture', selectedMeals: [chosen,
    { date, mealType: 'breakfast', mealName: 'Old auto breakfast', isAutoAssigned: true }], skippedDays: [] };
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: [chicken, beef] }], breakfastOptionsByDate: { [date]: [{ name: 'Breakfast option' }] }, snackOptionsByDate: {} }));
  t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'main' ? [
    { _id: chicken, mealName: 'Customer chicken', portionType: 'chicken' }, { _id: beef, mealName: 'Beef option', portionType: 'beef' },
  ] : []));
  t.mock.method(Record, 'find', () => query([]));
  t.mock.method(Record, 'findOne', () => query(record));
  const audit = [];
  t.mock.method(Record, 'updateOne', async (_filter, update) => { record.selectedMeals = update.$set.selectedMeals; audit.push(update.$push.kitchenAudit); return { modifiedCount: 1 }; });
  const append = t.mock.method(Record, 'findOneAndUpdate', async (_filter, update) => { record.selectedMeals.push(...update.$push.selectedMeals.$each); return record; });
  const nutrition = { customer_id: 'fixture', customer_email: 'fixture@example.invalid', customer_name: 'Fixture', subscription_id: 'fixture-sub', plan_name: 'Matter Core',
    meal_frequency: 1, breakfast_included: false, snacks_per_day: 0, exclusions: [], active_delivery_dates: [date, '2026-11-06'], double_delivery_dates: [date] };
  const result = await runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }], { snackOnly: true, includeBreakfast: true, matterInputs: [nutrition] });
  assert.equal(result.data.assignedMainMeals, 1);
  assert.equal(result.data.assignedBreakfast, 0);
  assert.equal(record.selectedMeals.length, 2);
  assert(record.selectedMeals.includes(chosen));
  assert(record.selectedMeals.every(meal => meal.mealType === 'main'));
  assert.equal(audit.length, 1);
  await runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }], { matterInputs: [nutrition] });
  assert.equal(append.mock.callCount(), 1, 'Retries do not duplicate the main meal');
  assert.equal(audit.length, 1, 'Retries do not repeat the removal audit');
});

for (const date of ['2026-10-31', '2026-11-01', '2026-11-19']) {
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
        return [{ mealName: 'Peanut bite', ...(date === '2026-11-19'
          ? { cycleMeal: { components: [{ type: 'Snack', name: 'Truffle', exclusions: ['Peanuts'] }] } }
          : { ingredients: 'Peanuts' }) }, { mealName: 'Safe bite', ingredients: 'Oats' }];
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

for (const [date, snacksPerDay, withBreakfast, partial, multiplier, plan = 'Matter Core', legacySnack = false] of [
  ['2026-11-16', 1, true, false, 2],
  ['2026-11-18', 2, true, true, 2],
  ['2026-11-18', 0, false, false, 2],
  ['2026-11-20', 2, true, false, 1],
  ['2026-11-16', 1, true, false, 1, 'Custom'],
  ['2026-11-16', 1, true, false, 2, 'Matter Core', true],
]) test(`Core assignment fills the dated add-on entitlement (${plan}, ${date}, ${snacksPerDay} snacks, breakfast: ${withBreakfast}, legacy snack: ${legacySnack})`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(`${date}T08:00:00Z`) });
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  const main = { _id: 'main', mealType: 'main', mealName: 'Core chicken', usedForCorePlan: true };
  const early = { name: 'Early bite', C: 20, P: 12, F: 6 };
  const late = { name: 'Late bite', C: 24, P: 16, F: 8 };
  let firstPool = [early];
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: [main._id] }],
    breakfastOptionsByDate: { [date]: [{ name: 'Eggs' }] },
    snackOptionsByDate: { [date]: { first: firstPool, second: [late] } } }));
  t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'main' ? [main] : []));
  t.mock.method(Breakfast, 'findOne', () => query({ presetsByName: { eggs: { C: 12, P: 20, F: 8 } } }));
  t.mock.method(Snack, 'findOne', () => query({ presetsByName: { 'early bite': early, 'late bite': late } }));
  const saved = Array.from({ length: multiplier }, (_, slotNumber) => ({
    date, mealType: 'main', mealName: main.mealName, slotNumber, isAutoAssigned: slotNumber > 0,
  }));
  if (partial) saved.push({ date, mealType: 'breakfast', mealName: 'Customer eggs' },
    { date, mealType: 'snack', mealName: late.name });
  if (legacySnack) saved.push({ date, mealType: 'snack', mealName: late.name, slotNumber: 1, isAutoAssigned: true });
  const before = JSON.stringify(saved);
  const record = { _id: 'record', matterCustomerId: 'fixture', selectedMeals: [...saved], skippedDays: [] };
  t.mock.method(Record, 'find', () => query([]));
  t.mock.method(Record, 'findOne', () => query(record));
  const writes = [];
  t.mock.method(Record, 'findOneAndUpdate', async (_, update) => {
    const appended = update.$push.selectedMeals.$each;
    writes.push(...appended);
    record.selectedMeals.push(...appended);
    return record;
  });
  const nutrition = { customer_id: 'fixture', customer_email: 'core@example.invalid', subscription_id: 'sub', plan_name: plan,
    meal_frequency: 1, breakfast_included: withBreakfast, snacks_per_day: snacksPerDay, exclusions: [],
    active_delivery_dates: ['2026-11-16', '2026-11-18', '2026-11-20'], double_delivery_dates: ['2026-11-16', '2026-11-18'] };
  const assign = () => runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }],
    { snackOnly: true, includeBreakfast: true, matterInputs: [nutrition] });
  const result = await assign();
  const snackWrites = writes.filter(meal => meal.mealType === 'snack');
  const snackNames = snacksPerDay === 1 ? Array(multiplier - Number(legacySnack)).fill(early.name)
    : snacksPerDay === 0 ? [] : partial ? [early.name, early.name, late.name] : [early.name, late.name];
  assert.equal(result.data.assignedBreakfast, withBreakfast ? multiplier - Number(partial) : 0);
  assert.equal(result.data.assignedSnacks, snacksPerDay * multiplier - Number(partial) - Number(legacySnack));
  assert.equal(writes.filter(meal => meal.mealType === 'breakfast').reduce((sum, meal) => sum + meal.quantity, 0),
    withBreakfast ? multiplier - Number(partial) : 0);
  assert.deepEqual(snackWrites.map(meal => meal.mealName), snackNames);
  for (const meal of snackWrites) {
    const option = meal.mealName === early.name ? early : late;
    assert.deepEqual(meal.snackMacros, { C: option.C / snacksPerDay, P: option.P / snacksPerDay, F: option.F / snacksPerDay });
  }
  assert.equal(JSON.stringify(record.selectedMeals.slice(0, saved.length)), before);
  const retry = await assign();
  assert.equal(retry.data.assignedBreakfast, 0);
  assert.equal(retry.data.assignedSnacks, 0);
  if (snacksPerDay === 1 && multiplier === 2) {
    t.mock.method(Record, 'updateOne', async (_, update) => {
      record.selectedMeals = update.$set.selectedMeals;
      return { modifiedCount: 1 };
    });
    assert.equal(record.selectedMeals.filter(meal => meal.coreDeliveryFoodDay === 2).length, legacySnack ? 1 : 2);
    if (!legacySnack) {
      nutrition.snacks_per_day = 2;
      firstPool = [];
      const increased = await assign();
      assert.equal(increased.data.assignedSnacks, 2);
      assert.deepEqual(record.selectedMeals.filter(meal => meal.mealType === 'snack').map(meal => [meal.mealName, meal.slotNumber]),
        [[early.name, 0], [early.name, 2], [late.name, 1], [late.name, 3]]);
      nutrition.snacks_per_day = 1;
    }
    nutrition.double_delivery_dates = nutrition.double_delivery_dates.filter(day => day !== date);
    const changed = await assign();
    assert.equal(changed.data.assignedBreakfast, 0);
    assert.equal(changed.data.assignedSnacks, 0);
    assert.deepEqual(record.selectedMeals.map(meal => meal.mealType).sort(), ['breakfast', 'main', 'snack']);
    assert.equal(record.selectedMeals.some(meal => meal.coreDeliveryFoodDay === 2), false);
    assert.equal(record.selectedMeals.find(meal => meal.mealType === 'snack').mealName, legacySnack ? late.name : early.name);
  }
});

test('Core snack assignment hydrates component tags and preserves saved customer choices', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-19T08:00:00Z') });
  const date = '2026-11-19';
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  const chosen = { date, mealType: 'main', mealName: 'Saved customer choice', quantity: 1 };
  const record = { _id: 'record', matterCustomerId: 'fixture', selectedMeals: [chosen], skippedDays: [] };
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: ['snack-id'] }],
    snackOptionsByDate: { [date]: { first: [{ name: 'BRAIN CLUSTER', exclusions: [] }], second: [{ name: 'Safe bite' }] } } }));
  t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'snack' ? [
    { mealName: 'BRAIN CLUSTER', cycleMeal: { components: [{ type: 'Snack', exclusions: ['All Nuts'] }] } },
    { mealName: 'Safe bite' },
  ] : []));
  t.mock.method(Record, 'find', () => query([]));
  t.mock.method(Record, 'findOne', () => query(record));
  t.mock.method(Snack, 'findOne', () => query({ presetsByName: { 'safe bite': { C: 15, P: 10, F: 6 } } }));
  const writes = [];
  t.mock.method(Record, 'findOneAndUpdate', async (_, update) => {
    const appended = update.$push.selectedMeals.$each;
    writes.push(...appended);
    record.selectedMeals.push(...appended);
    return record;
  });
  const nutrition = { customer_id: 'fixture', customer_email: 'core@example.invalid', subscription_id: 'sub', plan_name: 'Matter Core',
    meal_frequency: 1, breakfast_included: false, snacks_per_day: 2, exclusions: ['All Nuts'], active_delivery_dates: [date], double_delivery_dates: [] };
  const before = JSON.stringify(record);
  const result = await runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }], { snackOnly: true, matterInputs: [nutrition] });
  assert.equal(result.data.assignedSnacks, 1);
  assert.deepEqual(writes.map(meal => meal.mealName), ['Safe bite']);
  assert.equal(writes[0].slotNumber, 1);
  assert.equal(JSON.stringify({ ...record, selectedMeals: [record.selectedMeals[0]] }), before);
  const retry = await runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }], { snackOnly: true, matterInputs: [nutrition] });
  assert.equal(retry.data.assignedSnacks, 0);
  assert.equal(writes.length, 1, 'Retry cannot duplicate the second-slot snack');
  assert.equal(record.selectedMeals.length, 2);
});

test('double Core preparation falls back to an eligible second pool and preserves saved portions', async t => {
  const date = '2026-11-18';
  t.mock.timers.enable({ apis: ['Date'], now: new Date(`${date}T08:00:00Z`) });
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  const nutrition = { customer_id: 'fixture', customer_email: 'fixture@example.invalid', subscription_id: 'sub', plan_name: 'Matter Core',
    meal_frequency: 1, breakfast_included: false, snacks_per_day: 1, exclusions: ['All Nuts'], active_delivery_dates: [date], double_delivery_dates: [date] };
  const saved = [{ date, mealType: 'main', mealName: 'Saved main', quantity: 2 },
    { date, mealType: 'snack', mealName: 'Saved snack', slotNumber: 0 }];
  const record = { _id: 'record', email: nutrition.customer_email, matterCustomerId: 'fixture', selectedMeals: [...saved], skippedDays: [] };
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [],
    snackOptionsByDate: { [date]: { first: [{ name: 'Nut bite' }], second: [{ name: 'Safe bite' }] } } }));
  t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'snack'
    ? [{ mealName: 'Nut bite', cycleMeal: { components: [{ type: 'Snack', exclusions: ['All Nuts'] }] } }] : []));
  t.mock.method(Record, 'find', () => query([record]));
  t.mock.method(Record, 'findOne', () => query(record));
  t.mock.method(Snack, 'findOne', () => query({ presetsByName: { 'safe bite': { C: 15, P: 10, F: 6 } } }));
  t.mock.method(Record, 'findOneAndUpdate', async (_, update) => {
    record.selectedMeals.push(...update.$push.selectedMeals.$each);
    return record;
  });
  const assign = () => runAssignMatterCoreMeals('menu', date, [{ email: record.email }],
    { matterInputs: [nutrition], snackOnly: true, includeBreakfast: true });
  const result = await assign();
  assert.equal(result.data.assignedSnacks, 1);
  assert.equal(result.data.skippedSnackNoOption, 0);
  assert.deepEqual(record.selectedMeals.slice(0, saved.length), saved);
  assert.equal(record.selectedMeals.at(-1).mealName, 'Safe bite');
  assert.equal(record.selectedMeals.at(-1).coreDeliveryFoodDay, 2);
  assert.equal((await assign()).data.assignedSnacks, 0);
});

for (const changesPlan of [false, true]) test(`the snack-only route doubles Core snacks and follows updated entitlements (plan change: ${changesPlan})`, async t => {
  const date = '2026-11-18';
  t.mock.timers.enable({ apis: ['Date'], now: new Date(`${date}T08:00:00Z`) });
  const query = value => ({ select() { return this; }, lean: async () => value });
  const nutrition = { customer_id: 'fixture', customer_email: 'fixture@example.invalid', subscription_id: 'sub', plan_name: 'Matter Core',
    meal_frequency: null, breakfast_included: null, snacks_per_day: 1, exclusions: [], active_delivery_dates: [date], double_delivery_dates: [date] };
  const saved = [{ date, mealType: 'main', mealName: 'Saved main' }, { date, mealType: 'breakfast', mealName: 'Saved eggs' }];
  const record = { _id: 'record', email: nutrition.customer_email, selectedMeals: [...saved], skippedDays: [] };
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [],
    snackOptionsByDate: { [date]: { second: [{ name: 'Safe bite', C: 15, P: 10, F: 6 }] } } }));
  t.mock.method(MenuItem, 'find', filter => {
    assert.equal(filter.mealType, 'snack');
    return query([]);
  });
  t.mock.method(Record, 'find', () => Object.assign(Promise.resolve([record]), { select: () => query([record]) }));
  t.mock.method(Record, 'findOne', () => query(record));
  t.mock.method(Snack, 'findOne', () => query({ presetsByName: { 'safe bite': { C: 15, P: 10, F: 6 } } }));
  t.mock.method(Record, 'findOneAndUpdate', async (_, update) => {
    record.selectedMeals.push(...update.$push.selectedMeals.$each);
    return record;
  });
  const assign = () => runAssignSnacks('menu', { date }, { matterInputs: [nutrition] });
  assert.equal((await assign()).data.assigned, 2);
  assert.deepEqual(record.selectedMeals.slice(0, 2), saved);
  assert.deepEqual(record.selectedMeals.slice(2).map(meal => [meal.mealName, meal.coreDeliveryFoodDay]),
    [['Safe bite', 1], ['Safe bite', 2]]);
  assert.equal((await assign()).data.assigned, 0);
  t.mock.method(Record, 'updateOne', async (filter, update) => {
    assert.equal(filter.email, record.email);
    record.selectedMeals = update.$set.selectedMeals;
    return { modifiedCount: 1 };
  });
  if (changesPlan) {
    nutrition.plan_name = 'Custom';
    nutrition.snacks_per_day = 0;
  } else nutrition.double_delivery_dates = [];
  assert.equal((await assign()).data.assigned, 0);
  assert.equal(record.selectedMeals.length, changesPlan ? 2 : 3);
  assert.deepEqual(record.selectedMeals.slice(0, 2), saved);
});

test('Core retry infers an unnumbered same-name snack from the eligible second pool', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-19T08:00:00Z') });
  const date = '2026-11-19';
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  const record = { _id: 'record', matterCustomerId: 'fixture', skippedDays: [], selectedMeals: [
    { date, mealType: 'main', mealName: 'Customer choice', quantity: 1 },
    { date, mealType: 'snack', mealName: 'Shared snack', quantity: 1, isAutoAssigned: true },
  ] };
  const before = JSON.stringify(record);
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: ['snack-id'] }],
    snackOptionsByDate: { [date]: { first: [{ name: 'Shared snack', exclusions: ['All Nuts'] }],
      second: [{ name: 'Shared snack', exclusions: [] }] } } }));
  t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'snack' ? [
    { mealName: 'Shared snack', cycleMeal: { components: [{ type: 'Snack', name: 'Shared snack', exclusions: [] }] } },
  ] : []));
  t.mock.method(Record, 'find', () => query([]));
  t.mock.method(Record, 'findOne', () => query(record));
  t.mock.method(Record, 'findOneAndUpdate', () => assert.fail('Retry must not append the second-pool snack again'));
  const nutrition = { customer_id: 'fixture', customer_email: 'core@example.invalid', subscription_id: 'sub', plan_name: 'Matter Core',
    meal_frequency: 1, breakfast_included: false, snacks_per_day: 2, exclusions: ['All Nuts'], active_delivery_dates: [date], double_delivery_dates: [] };
  for (let retry = 0; retry < 2; retry++) {
    const result = await runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }], { snackOnly: true, matterInputs: [nutrition] });
    assert.equal(result.data.assignedSnacks, 0);
  }
  assert.equal(JSON.stringify(record), before, 'Legacy snack and customer selection stay unchanged');
});

test('Core retries preserve the original second slot of a now-ineligible legacy snack', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-19T08:00:00Z') });
  const date = '2026-11-19';
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  const saved = [
    { date, mealType: 'main', mealName: 'Customer choice', quantity: 1 },
    { date, mealType: 'snack', mealName: 'Old second', quantity: 1, isAutoAssigned: true },
  ];
  const before = JSON.stringify(saved);
  const record = { _id: 'record', matterCustomerId: 'fixture', skippedDays: [], selectedMeals: [...saved] };
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: ['snack-id'] }],
    snackOptionsByDate: { [date]: { first: [{ name: 'Safe first' }],
      second: [{ name: 'Old second' }, { name: 'Safe second' }] } } }));
  t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'snack' ? [
    { mealName: 'Old second', cycleMeal: { components: [{ type: 'Snack', exclusions: ['All Nuts'] }] } },
    { mealName: 'Safe first' }, { mealName: 'Safe second' },
  ] : []));
  t.mock.method(Record, 'find', () => query([]));
  t.mock.method(Record, 'findOne', () => query(record));
  t.mock.method(Snack, 'findOne', () => query({ presetsByName: {
    'safe first': { C: 15, P: 10, F: 6 }, 'safe second': { C: 15, P: 10, F: 6 },
  } }));
  const writes = [];
  t.mock.method(Record, 'findOneAndUpdate', async (_, update) => {
    const appended = update.$push.selectedMeals.$each;
    writes.push(...appended); record.selectedMeals.push(...appended); return record;
  });
  const nutrition = { customer_id: 'fixture', customer_email: 'core@example.invalid', subscription_id: 'sub', plan_name: 'Matter Core',
    meal_frequency: 1, breakfast_included: false, snacks_per_day: 2, exclusions: ['All Nuts'], active_delivery_dates: [date], double_delivery_dates: [] };
  for (const expected of [1, 0, 0]) {
    const result = await runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }], { snackOnly: true, matterInputs: [nutrition] });
    assert.equal(result.data.assignedSnacks, expected);
  }
  assert.deepEqual(writes.map(meal => [meal.mealName, meal.slotNumber]), [['Safe first', 0]]);
  assert.equal(JSON.stringify(record.selectedMeals.slice(0, 2)), before, 'Saved choices are never rewritten');
});

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

for (const mode of ['tagged', 'legacy', 'mixed', 'legacy-sub', 'overlapping-pools', 'same-name sub', 'spaced main', 'only tagged sub', 'core', 'legacy-conflict']) {
  test(`meal assignment checks dated component exclusions (${mode})`, async t => {
    const date = '2026-11-20';
    const mainId = '507f1f77bcf86cd799439021', subId = '507f1f77bcf86cd799439022';
    const legacy = ['legacy', 'legacy-conflict', 'mixed', 'legacy-sub', 'overlapping-pools', 'same-name sub', 'spaced main', 'only tagged sub'].includes(mode);
    const overlap = mode === 'overlapping-pools';
    const sharedName = ['same-name sub', 'spaced main', 'only tagged sub'].includes(mode);
    const subName = sharedName ? 'Roast Chicken' : 'Lemon Chicken';
    const conflict = mode === 'legacy-conflict';
    const core = mode === 'core';
    const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
    const dishes = [
      { _id: mainId, mealName: mode === 'spaced main' ? 'Roast  Chicken' : 'Roast Chicken', portionType: 'chicken', rotationCategory: overlap ? 'sub' : legacy ? '' : 'main',
        usedForCorePlan: core, ...(!overlap && { cycleMeal: { tags: 'SALAD BASE', components: [
          { type: 'Carb', name: 'Pilaf', exclusions: ['All Nuts'] },
          { type: 'Sauce 2', name: 'Dressing', allergens: ['Sesame'] },
          { type: 'Garnish', ingredients: [{ name: 'Capsicum', visible: false }] },
        ] } }) },
      ...(!conflict ? [{ _id: subId, mealName: subName, portionType: 'chicken',
        rotationCategory: ['legacy', 'legacy-sub'].includes(mode) ? '' : 'sub', usedForCorePlan: core }] : []),
      ...(mode === 'legacy-sub' ? [{
        _id: '507f1f77bcf86cd799439023', mealName: 'Seeded Chicken', portionType: 'chicken', rotationCategory: 'sub',
        cycleMeal: { components: [{ type: 'Sauce', exclusions: ['Sesame'] }] },
      }] : []),
    ];
    if (mode === 'only tagged sub') dishes.shift();
    t.mock.method(WeeklyMenu, 'findById', () => query({
      meals: [{ items: dishes.map(dish => dish._id) }],
      ...(legacy && { mainMealOptionsByDate: { [date]: {
        mainMeals: [{ name: sharedName ? subName : 'ROAST  CHICKEN', type: 'chicken', exclusions: ['Cabbage'] }],
        subMeals: [
          ...(!conflict && mode !== 'mixed' ? [{ name: subName, type: 'chicken' }] : []),
          ...(overlap ? [{ name: 'Roast Chicken', type: 'chicken' }] : []),
        ],
      } } }),
    }));
    t.mock.method(MenuItem, 'find', filter => {
      assert.deepEqual(filter._id.$in, dishes.map(dish => dish._id));
      assert.equal(filter.itemDate.toISOString().slice(0, 10), date);
      if (filter.mealType !== 'main') return query([]);
      if (core) assert.equal(filter.usedForCorePlan, true);
      return query(dishes);
    });
    const existing = { _id: 'record', selectedMeals: [{ date, mealType: 'main', mealName: 'Saved customer meal', quantity: 1 }] };
    const saved = JSON.stringify(existing.selectedMeals[0]);
    t.mock.method(Record, 'find', () => query([]));
    t.mock.method(Record, 'findOne', () => query(existing));
    const write = t.mock.method(Record, 'findOneAndUpdate', async (_, update) => {
      existing.selectedMeals.push(...update.$push.selectedMeals.$each);
      return existing;
    });
    const nutrition = { customer_id: 'fixture', customer_email: 'customer@example.invalid', subscription_id: 'sub',
      plan_name: core ? 'Matter Core' : 'Custom', meal_frequency: 2, breakfast_included: false, snacks_per_day: 0,
      exclusions: ['All Nuts', 'Sesame', 'Capsicum', 'Cabbage'], active_delivery_dates: [date], double_delivery_dates: [] };
    const assign = core ? runAssignMatterCoreMeals : runAssignMainMeals;
    const result = await assign('menu', date, [{ email: nutrition.customer_email }], { matterInputs: [nutrition] });
    const added = existing.selectedMeals[1];
    assert.equal(JSON.stringify(existing.selectedMeals[0]), saved);
    assert.equal(added.mealName, conflict ? 'ROAST  CHICKEN' : subName);
    assert.equal(added.menuItemId, conflict ? mainId : subId);
    assert.equal(added.isAutoAssigned, true);
    assert.deepEqual(added.exclusionConflict, conflict ? ['all nuts', 'sesame', 'capsicum', 'cabbage'] : []);
    if (conflict) {
      assert.equal(result.data.assignedWithExclusionConflict, 1);
      assert.deepEqual(added.carbConflict, ['all nuts']);
      assert.deepEqual(added.vegConflict, ['sesame']);
      assert.equal(added.needsGarnishChange, true);
      assert.equal(added.needsSauceChange, false);
      assert.equal(added.carbVegAction, 'replace');
    }
    await assign('menu', date, [{ email: nutrition.customer_email }], { matterInputs: [nutrition] });
    assert.equal(write.mock.callCount(), 1);
  });
}

for (const mode of ['no main', 'distinct mains', 'placeholder ID', 'older ID', 'duplicate IDs', 'shared alias', 'reserved alias', 'stale alias', 'ambiguous alias', 'dated intolerance', 'renamed selection', 'verified copies', 'restricted copy', 'saved copy', 'saved rotation alias', 'separate copy', 'same-name dated substitute', 'configured copy', 'restricted legacy copy', 'duplicate restriction tags', 'renamed restricted copy', 'generic ingredient variants', 'fuzzy component variants', 'hidden ingredient copy']) {
  test(`standard rotation preserves candidate identity (${mode})`, async t => {
    const date = '2026-11-20';
    const primary = { _id: '507f1f77bcf86cd799439024', mealName: 'House Bowl', portionType: 'chicken', rotationCategory: 'main' };
    const sub = { _id: '507f1f77bcf86cd799439025', mealName: 'House  Bowl', portionType: 'chicken', rotationCategory: 'sub' };
    const duplicate = { ...primary, _id: '507f1f77bcf86cd799439027', mealName: 'HOUSE BOWL' };
    const distinctVariants = ['generic ingredient variants', 'fuzzy component variants'].includes(mode);
    const copies = distinctVariants || ['verified copies', 'restricted copy', 'saved copy', 'separate copy', 'same-name dated substitute', 'configured copy', 'restricted legacy copy', 'duplicate restriction tags', 'renamed restricted copy', 'hidden ingredient copy'].includes(mode);
    const usesAlias = copies || ['shared alias', 'reserved alias', 'stale alias', 'ambiguous alias', 'dated intolerance', 'renamed selection', 'saved rotation alias'].includes(mode);
    const restricted = distinctVariants || ['reserved alias', 'ambiguous alias', 'dated intolerance', 'restricted copy', 'separate copy', 'same-name dated substitute', 'configured copy', 'restricted legacy copy', 'renamed restricted copy', 'hidden ingredient copy'].includes(mode);
    const items = mode === 'no main' ? [sub] : [primary, ...(mode === 'duplicate IDs' ? [duplicate] : []), sub];
    const alternative = { _id: '507f1f77bcf86cd799439028', mealName: 'Lemon Chicken', portionType: 'chicken', rotationCategory: 'sub' };
    if (copies) {
      if (mode !== 'restricted legacy copy') {
        primary.cycleMeal = sub.cycleMeal = { id: 'recipe-1', name: 'House Bowl', mealType: 'Chicken',
          components: [{ id: 'p', type: 'Protein', name: 'Chicken' }] };
      }
      if (mode === 'duplicate restriction tags') {
        primary.intolerances = 'Sesame';
        sub.intolerances = 'Sesame; Sesame';
      }
      if (!restricted || ['renamed restricted copy', 'hidden ingredient copy'].includes(mode)) items.push(alternative);
      if (mode === 'renamed restricted copy') sub.mealName = 'Lunch House Bowl';
      if (mode === 'hidden ingredient copy') for (const [item, visible] of [[primary, true], [sub, false]]) {
        item.cycleMeal = { ...item.cycleMeal, components: [{ ...item.cycleMeal.components[0], ingredients: [{ name: 'Parsley', visible }] }] };
      }
      if (mode === 'restricted copy') {
        primary.intolerances = 'Dairy';
        primary.portionType = '';
        primary.ingredients = 'Prepared chicken, herbs';
        sub.proteinSource = 'Chicken';
      }
      if (mode === 'separate copy') primary.intolerances = 'Sesame';
      if (mode === 'configured copy') sub.mealName = primary.mealName;
      if (mode === 'same-name dated substitute') {
        sub.mealName = primary.mealName;
        primary.sauce = 'Sesame sauce';
        sub.sauce = 'Lemon dressing';
      }
      if (mode === 'generic ingredient variants') {
        primary.ingredients = 'Sesame';
        sub.ingredients = 'Lemon';
      }
      if (mode === 'fuzzy component variants') {
        primary.sauce = 'Sesame sauce';
        sub.sauce = 'Lemon dressing';
      }
    }
    if (mode === 'saved rotation alias') items.push(alternative);
    if (usesAlias) primary.rotationCategory = '';
    if (mode === 'dated intolerance') primary.intolerances = 'Sesame';
    if (mode === 'renamed selection') primary.mealName = 'Seasonal Bowl';
    const query = value => ({ select() { return this; }, lean: async () => value });
    t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: items.map(item => item._id) }],
      ...(usesAlias && { mainMealOptionsByDate: { [date]: {
        mainMeals: [{ name: copies && mode !== 'fuzzy component variants' || mode === 'renamed selection' ? 'House Bowl' : 'House   Bowl', type: 'chicken',
          exclusions: restricted && mode !== 'dated intolerance' ? ['Sesame'] : [] }],
        subMeals: copies && !['separate copy', 'configured copy'].includes(mode) || ['ambiguous alias', 'dated intolerance', 'saved rotation alias'].includes(mode) ? []
          : [{ name: restricted || ['stale alias', 'renamed selection'].includes(mode) ? sub.mealName : primary.mealName, type: 'chicken' }],
      } } }),
    }));
    t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'main' ? items : []));
    t.mock.method(Record, 'find', () => query([]));
    const custom = { date, mealType: 'main', mealName: 'Meal 1 - Protein: Beef', proteinChoice: 'Beef', menuItemId: primary._id };
    const older = { date, mealType: 'main', mealName: primary.mealName, menuItemId: '507f1f77bcf86cd799439026' };
    const saved = mode === 'placeholder ID' ? custom : mode === 'older ID' ? older
      : mode === 'duplicate IDs' ? { ...older, menuItemId: primary._id }
        : mode === 'stale alias' ? { ...older, mealName: 'House   Bowl' }
          : mode === 'renamed selection' ? { ...older, mealName: 'House Bowl', menuItemId: primary._id }
            : mode === 'saved copy' ? { ...older, mealName: sub.mealName, menuItemId: sub._id }
              : mode === 'saved rotation alias' ? { ...older, mealName: 'House   Bowl', menuItemId: sub._id } : null;
    t.mock.method(Record, 'findOne', () => query(saved ? { _id: 'saved', selectedMeals: [saved] } : null));
    const writes = [];
    t.mock.method(Record, 'findOneAndUpdate', async (_, update) => {
      writes.push(...update.$push.selectedMeals.$each);
      return {};
    });
    const nutrition = { customer_id: 'fixture', customer_email: 'customer@example.invalid', subscription_id: 'sub',
      meal_frequency: restricted ? 1 : 2, breakfast_included: false, snacks_per_day: 0,
      exclusions: restricted ? ['Sesame'] : [], active_delivery_dates: [date] };
    const result = await runAssignMainMeals('menu', date, [{ email: nutrition.customer_email }], { matterInputs: [nutrition] });
    if (mode !== 'no main') {
      const expected = ['saved copy', 'saved rotation alias', 'renamed restricted copy', 'hidden ingredient copy'].includes(mode) ? [alternative._id]
        : ['verified copies', 'duplicate restriction tags'].includes(mode) ? [primary._id, alternative._id]
          : ['placeholder ID', 'ambiguous alias', 'restricted copy', 'restricted legacy copy'].includes(mode) ? [primary._id] : saved || restricted ? [sub._id]
        : usesAlias ? [sub._id, primary._id] : [primary._id, sub._id];
      assert.deepEqual(writes.map(meal => meal.menuItemId), expected);
      if (mode === 'shared alias') assert.equal(writes[0].mealName, 'House   Bowl');
      assert.equal(result.data.repeatedDish, 0);
      assert.deepEqual(writes[0].exclusionConflict, ['ambiguous alias', 'restricted copy', 'restricted legacy copy'].includes(mode) ? ['sesame'] : []);
    } else {
      assert.equal(result.status, 400);
      assert.deepEqual(writes, []);
    }
  });
}

for (const doubleDay of [false, true]) test(`a Core top-up prefers a safe dish different from the saved choice (double day: ${doubleDay})`, async t => {
  const date = '2026-11-18';
  const items = ['Excluded Bowl', 'Lemon Chicken', 'Roast Chicken'].map((mealName, index) => ({
    _id: `507f1f77bcf86cd79943903${index}`, mealName, mealType: 'main',
    usedForCorePlan: true, ...(index === 0 && { cycleMeal: { allergens: ['Sesame'] } }),
  }));
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: items.map(item => item._id) }] }));
  t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'main' ? items : []));
  t.mock.method(Record, 'find', () => query([]));
  const saved = { date, mealName: items[2].mealName, mealType: 'main', menuItemId: items[2]._id };
  const record = { _id: 'saved', selectedMeals: [saved] };
  t.mock.method(Record, 'findOne', () => query(record));
  const write = t.mock.method(Record, 'findOneAndUpdate', async (_, update) => {
    record.selectedMeals.push(...update.$push.selectedMeals.$each);
    return record;
  });
  const nutrition = { customer_id: 'fixture', customer_email: 'customer@example.invalid', subscription_id: 'sub',
    plan_name: 'Matter Core', meal_frequency: doubleDay ? 1 : 2, breakfast_included: false, snacks_per_day: 0, exclusions: ['Sesame'],
    active_delivery_dates: [date], double_delivery_dates: doubleDay ? [date] : [] };
  for (const expected of [1, 0]) {
    const result = await runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }], { matterInputs: [nutrition], snackOnly: doubleDay });
    assert.equal(result.data.assignedMainMeals, expected);
  }
  assert.deepEqual(record.selectedMeals.map(meal => meal.menuItemId), [items[2]._id, items[1]._id]);
  assert.equal(write.mock.callCount(), 1);
});

for (const mode of ['empty', 'one saved', 'reverse slot order', 'extra first dish', 'extra second dish', 'stale name', 'saved repeat', 'reserved repeat', 'repeat saved set', 'full first quantities', 'repeat identical dish', 'all conflicted', 'copied slot', 'quantity with saved repeat', 'numbered copies', 'same-name quantities', 'mixed numbered rows', 'numbered repeat with quantity', 'replace excluded pair', 'excluded same-name recipe', 'one merged pair', 'same-name counterpart', 'four saved portions', 'two saved repeats', 'overlapping saved slots', 'known repeat slots', 'known repeat merged', 'known off-rotation repeat', 'same-name proteins', 'saved same-name protein', 'pair before parity', 'physical expanded slots', 'third merged dish', 'legacy variants', 'saved small pool', 'paired small pool tails', 'late merged counterpart', 'warned same-name rotation', 'already doubled counterpart', 'same-name restrictions', 'saved same-name restriction', 'partial four-meal rotation', 'preserve full pair plan', 'legacy snapshot variants', 'complete saved rotation', 'complete merged rotation']) test(`Core doubles the actual eligible first rotation (${mode})`, async t => {
  const date = '2026-11-18';
  const items = ['House Bowl', 'HOUSE BOWL', 'Lemon Chicken'].map((mealName, index) => ({
    _id: `507f1f77bcf86cd79943904${index}`, mealName, mealType: 'main', usedForCorePlan: true,
  }));
  const fullSavedRotation = ['complete saved rotation', 'complete merged rotation'].includes(mode);
  if (fullSavedRotation || ['stale name', 'saved repeat', 'reserved repeat', 'repeat saved set', 'numbered copies', 'replace excluded pair', 'pair before parity', 'third merged dish', 'preserve full pair plan'].includes(mode)) items[1].mealName = 'Roast Chicken';
  if (['same-name proteins', 'saved same-name protein'].includes(mode)) {
    items[0].portionType = 'chicken';
    items[1].portionType = 'beef';
  }
  if (mode === 'legacy variants') {
    items[0].ingredients = 'Rice, Chicken';
    items[1].ingredients = 'Rice, Beef';
  }
  if (mode === 'legacy snapshot variants') {
    items[0].cycleMeal = { ingredients: ['Rice'] };
    items[1].cycleMeal = { ingredients: ['Potato'] };
  }
  if (['same-name restrictions', 'saved same-name restriction'].includes(mode)) {
    items[0].allergens = ['Sesame'];
    items[1].allergens = ['Dairy'];
  }
  if (['replace excluded pair', 'excluded same-name recipe'].includes(mode)) items[0].cycleMeal = { allergens: ['Sesame'] };
  if (['all conflicted', 'copied slot'].includes(mode)) for (const item of items) {
    if (mode === 'all conflicted' || item !== items[0]) item.cycleMeal = { allergens: ['Sesame'] };
  }
  if (mode === 'warned same-name rotation') {
    items[0].cycleMeal = { allergens: ['Sesame'] };
    items[1].cycleMeal = { allergens: ['Dairy'] };
    items[2].cycleMeal = { allergens: ['Sesame', 'Dairy'] };
  }
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  const dated = ['known repeat slots', 'known repeat merged', 'known off-rotation repeat', 'saved small pool', 'paired small pool tails', 'late merged counterpart', 'partial four-meal rotation'].includes(mode) ? [items[0], items[2]] : items;
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: dated.map(item => item._id) }] }));
  t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'main' ? dated : []));
  t.mock.method(Record, 'find', () => query([]));
  const saved = index => ({ date, mealName: items[index].mealName, mealType: 'main', menuItemId: items[index]._id });
  const existing = {
    empty: [], 'one saved': [saved(2)],
    'reverse slot order': [{ ...saved(2), slotNumber: 1 }, { ...saved(0), slotNumber: 0 }],
    'extra first dish': [{ ...saved(0), quantity: 2 }, saved(2)],
    'extra second dish': [saved(0), { ...saved(2), quantity: 2 }],
    'stale name': [{ ...saved(0), mealName: items[1].mealName }],
    'saved repeat': [{ ...saved(0), slotNumber: 2 }],
    'reserved repeat': [{ ...saved(0), slotNumber: 3 }],
    'repeat saved set': [{ ...saved(1), slotNumber: 0 }, { ...saved(2), slotNumber: 1 }, { ...saved(2), slotNumber: 2 }],
    'full first quantities': [{ ...saved(2), quantity: 2 }, saved(0)],
    'repeat identical dish': [0, 1, 2].map(slotNumber => ({ ...saved(2), slotNumber })),
    'all conflicted': [{ ...saved(2), slotNumber: 1 }],
    'copied slot': [{ ...saved(0), slotNumber: 0, quantity: 2 }, { ...saved(2), slotNumber: 3 }],
    'quantity with saved repeat': [{ ...saved(0), quantity: 2 }, { ...saved(2), slotNumber: 2 }],
    'numbered copies': [{ ...saved(0), slotNumber: 0 }, { ...saved(2), slotNumber: 1, quantity: 2 },
      { ...saved(0), slotNumber: 3 }, { ...saved(2), slotNumber: 4 }],
    'same-name quantities': [{ ...saved(0), slotNumber: 0 }, { ...saved(1), slotNumber: 1, quantity: 2 }],
    'mixed numbered rows': [{ ...saved(0), slotNumber: 0, quantity: 2 }, saved(2)],
    'numbered repeat with quantity': [{ ...saved(0), slotNumber: 0, quantity: 2 }, { ...saved(2), slotNumber: 2 }],
    'replace excluded pair': [{ ...saved(0), quantity: 2 }],
    'excluded same-name recipe': [saved(0), saved(1)],
    'one merged pair': [{ ...saved(0), quantity: 2 }],
    'same-name counterpart': [{ ...saved(0), slotNumber: 0 }, { ...saved(1), slotNumber: 3 }],
    'four saved portions': [{ ...saved(0), quantity: 4 }],
    'two saved repeats': [{ ...saved(2), slotNumber: 3 }, { ...saved(2), slotNumber: 4 }],
    'overlapping saved slots': [{ ...saved(2), slotNumber: 2 }, { ...saved(0), slotNumber: 2, quantity: 2 }],
    'known repeat slots': [{ ...saved(2), slotNumber: 0 }, { ...saved(2), slotNumber: 1 }, { ...saved(0), slotNumber: 2 }],
    'known repeat merged': [{ ...saved(2), slotNumber: 0, quantity: 2 }, { ...saved(0), slotNumber: 2 }],
    'known off-rotation repeat': [{ ...saved(0), slotNumber: 0 }, { ...saved(0), slotNumber: 1 }, { ...saved(2), slotNumber: 2 }],
    'same-name proteins': [], 'saved same-name protein': [{ ...saved(0), slotNumber: 0 }],
    'pair before parity': [{ ...saved(0), slotNumber: 0 }, { ...saved(1), slotNumber: 2 }, { ...saved(0), slotNumber: 3 }, { ...saved(2), slotNumber: 4 }],
    'physical expanded slots': [{ ...saved(0), quantity: 2 }, { ...saved(2), slotNumber: 2 }, { ...saved(0), slotNumber: 3, quantity: 2 }],
    'third merged dish': [{ ...saved(0), quantity: 2 }, saved(2)],
    'legacy variants': [], 'saved small pool': [{ ...saved(0), slotNumber: 2 }, { ...saved(0), slotNumber: 3 }],
    'paired small pool tails': [{ ...saved(0), slotNumber: 2 }, { ...saved(0), slotNumber: 5 }],
    'late merged counterpart': [{ ...saved(0), slotNumber: 0, quantity: 2 }, { ...saved(2), slotNumber: 3 }],
    'warned same-name rotation': [],
    'already doubled counterpart': [{ ...saved(0), slotNumber: 0 }, { ...saved(2), slotNumber: 2 }, { ...saved(2), slotNumber: 3 }],
    'same-name restrictions': [], 'saved same-name restriction': [{ ...saved(0), slotNumber: 0 }],
    'partial four-meal rotation': [saved(0), { ...saved(2), quantity: 2 }, saved(0), saved(0)],
    'preserve full pair plan': [0, 1, 2].map(slotNumber => ({ ...saved(2), slotNumber })).concat({ ...saved(1), slotNumber: 3 }),
    'legacy snapshot variants': [],
    'complete saved rotation': [1, 2, 2, 1, 2].map((index, slotNumber) => ({ ...saved(index), slotNumber })),
    'complete merged rotation': [{ ...saved(1), slotNumber: 0 }, { ...saved(2), slotNumber: 1, quantity: 2 },
      { ...saved(1), slotNumber: 3 }, { ...saved(2), slotNumber: 4 }],
  }[mode];
  const record = { _id: 'record', selectedMeals: [...existing] };
  t.mock.method(Record, 'findOne', () => query(record));
  t.mock.method(Record, 'findOneAndUpdate', async (_, update) => {
    record.selectedMeals.push(...update.$push.selectedMeals.$each);
    return record;
  });
  const nutrition = { customer_id: 'fixture', customer_email: 'customer@example.invalid', subscription_id: 'sub',
    plan_name: 'Matter Core',
    meal_frequency: mode === 'partial four-meal rotation' || fullSavedRotation ? 4
      : ['full first quantities', 'numbered copies', 'replace excluded pair', 'four saved portions', 'two saved repeats', 'overlapping saved slots', 'pair before parity', 'physical expanded slots', 'third merged dish', 'saved small pool', 'paired small pool tails', 'preserve full pair plan'].includes(mode) ? 3 : 2,
    breakfast_included: false, snacks_per_day: 0,
    exclusions: mode === 'warned same-name rotation' ? ['Sesame', 'Dairy']
      : ['all conflicted', 'copied slot', 'replace excluded pair', 'excluded same-name recipe'].includes(mode) ? ['Sesame'] : [],
    active_delivery_dates: [date], double_delivery_dates: [date] };
  const result = await runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }], { matterInputs: [nutrition] });
  const appended = {
    empty: [0, 2, 0, 2], 'one saved': [1, 2, 1],
    'reverse slot order': [0, 2], 'extra first dish': [2], 'extra second dish': [0],
    'stale name': [1, 0, 1],
    'saved repeat': [0, 1, 1], 'reserved repeat': [1, 0, 1],
    'repeat saved set': [1],
    'full first quantities': [2, 0, 2],
    'repeat identical dish': [2], 'all conflicted': [0, 0, 2], 'copied slot': [0],
    'quantity with saved repeat': [2],
    'numbered copies': [2],
    'same-name quantities': [0],
    'mixed numbered rows': [2],
    'numbered repeat with quantity': [2],
    'replace excluded pair': [1, 2, 2, 1],
    'excluded same-name recipe': [2, 1],
    'one merged pair': [2, 2], 'same-name counterpart': [1, 0],
    'four saved portions': [2, 2],
    'two saved repeats': [2, 2, 0, 0],
    'overlapping saved slots': [0, 0, 2],
    'known repeat slots': [2], 'known repeat merged': [2],
    'known off-rotation repeat': [2],
    'same-name proteins': [0, 1, 0, 1], 'saved same-name protein': [1, 0, 1],
    'pair before parity': [2, 1],
    'physical expanded slots': [2],
    'third merged dish': [2, 1, 1],
    'legacy variants': [0, 1, 0, 1], 'saved small pool': [0, 2, 2, 0],
    'paired small pool tails': [0, 2, 0, 2],
    'late merged counterpart': [2],
    'warned same-name rotation': [0, 1, 0, 1],
    'already doubled counterpart': [0],
    'same-name restrictions': [0, 1, 0, 1], 'saved same-name restriction': [1, 0, 1],
    'partial four-meal rotation': [2, 0, 2],
    'preserve full pair plan': [2, 1],
    'legacy snapshot variants': [0, 1, 0, 1],
    'complete saved rotation': [2, 1, 1], 'complete merged rotation': [2, 1, 1],
  }[mode];
  assert.equal(result.data.assignedMainMeals, appended.length);
  assert.deepEqual(record.selectedMeals.slice(0, existing.length), existing);
  assert.deepEqual(record.selectedMeals.slice(existing.length).map(meal => meal.menuItemId), appended.map(index => items[index]._id));
  if (mode === 'all conflicted') assert(record.selectedMeals.slice(existing.length).every(meal => meal.exclusionConflict.includes('Sesame')));
  if (mode === 'warned same-name rotation') {
    assert.deepEqual(record.selectedMeals.map(meal => meal.exclusionConflict), [['Sesame'], ['Dairy'], ['Sesame'], ['Dairy']]);
  }
  if (mode === 'copied slot') assert.equal(record.selectedMeals.at(-1).slotNumber, 2);
  if (mode === 'physical expanded slots') assert.equal(record.selectedMeals.at(-1).slotNumber, 5);
  if (mode === 'overlapping saved slots') {
    assert(record.selectedMeals.slice(existing.length).every(meal => [0, 1, 4, 5].includes(meal.slotNumber)));
  }
});

test('Core replaces the repeat of an excluded saved dish without repeating the other dish twice', async t => {
  const date = '2026-11-18';
  const items = ['Spicy Chicken', 'Lemon Chicken', 'Roast Chicken'].map((mealName, index) => ({
    _id: `507f1f77bcf86cd79943905${index}`, mealName, mealType: 'main', usedForCorePlan: true,
    ...(index === 0 && { cycleMeal: { components: [{ type: 'Sauce', exclusions: ['Sesame'] }] } }),
  }));
  const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
  t.mock.method(WeeklyMenu, 'findById', () => query({ meals: [{ items: items.map(item => item._id) }] }));
  t.mock.method(MenuItem, 'find', filter => query(filter.mealType === 'main' ? items : []));
  t.mock.method(Record, 'find', () => query([]));
  const record = { _id: 'record', selectedMeals: items.slice(0, 2).map(item => ({
    date, mealName: item.mealName, mealType: 'main', menuItemId: item._id,
  })) };
  t.mock.method(Record, 'findOne', () => query(record));
  t.mock.method(Record, 'findOneAndUpdate', async (_, update) => {
    record.selectedMeals.push(...update.$push.selectedMeals.$each);
    return record;
  });
  const nutrition = { customer_id: 'fixture', customer_email: 'customer@example.invalid', subscription_id: 'sub',
    plan_name: 'Matter Core', meal_frequency: 2, breakfast_included: false, snacks_per_day: 0, exclusions: ['Sesame'],
    active_delivery_dates: [date], double_delivery_dates: [date] };
  const result = await runAssignMatterCoreMeals('menu', date, [{ email: nutrition.customer_email }], { matterInputs: [nutrition] });
  assert.equal(result.data.assignedMainMeals, 2);
  assert.deepEqual(record.selectedMeals.map(meal => meal.menuItemId), [0, 1, 2, 1].map(index => items[index]._id));
});
