import test from 'node:test';
import assert from 'node:assert/strict';
import router from './menus.js';
import Menu from '../models/WeeklyMenu.js';
import Item from '../models/MenuItem.js';
import Record from '../models/MenuSelectionRecord.js';
import State from '../models/MealCreationState.js';
const handler = router.stack.find(layer => layer.route?.path === '/:id/kitchen-components').route.stack.at(-1).handle;
const response = () => ({ set() { return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

test('component names are read only from this menu and date, without customer reads or writes', async t => {
  const items = [{ _id: 'linked', mealName: 'Bowl', cycleMeal: { components: [{ type: 'Carb', name: 'Rice' }] } }];
  t.mock.method(Menu, 'findById', id => { assert.equal(id, 'menu'); return { select(fields) { assert.equal(fields, 'meals'); return this; }, lean: async () => ({ meals: [{ items: ['linked'] }] }) }; });
  t.mock.method(Item, 'find', filter => {
    assert.deepEqual(filter, { _id: { $in: ['linked'] }, itemDate: new Date('2026-11-20') });
    return { select(fields) { assert.ok(fields.includes('cycleMeal.components.name')); return this; }, lean: async () => items };
  });
  t.mock.method(Record, 'find', () => assert.fail('No customer download'));
  t.mock.method(Record, 'updateOne', () => assert.fail('Read only'));
  const res = response(); await handler({ params: { id: 'menu' }, query: { date: '2026-11-20' } }, res);
  assert.deepEqual(res.body, { success: true, data: items });
});

test('existing dated menu follows the saved library quantity by ID without rewriting selections or recipes', async t => {
  const item = { _id: 'linked', mealName: 'Bowl', mealType: 'main', cycleMeal: { id: 'old-id', qtyUnit: 'KG', components: [{ type: 'Protein', name: 'Dated recipe' }] } };
  let meal = { id: 'library-id', qtyUnit: 'PCS', gramsPerPiece: 100 };
  t.mock.method(Menu, 'findById', () => ({ select() { return this; }, lean: async () => ({ meals: [{ items: ['linked'] }] }) }));
  t.mock.method(Item, 'find', () => ({ select() { return this; }, lean: async () => [item] }));
  t.mock.method(State, 'findById', () => ({ select() { return this; }, lean: async () => ({
    catalogue: { meals: [meal] }, aliases: [{ from: 'old-id', to: 'library-id' }],
  }) }));
  t.mock.method(Record, 'updateOne', () => assert.fail('Read only'));
  t.mock.method(Item, 'updateOne', () => assert.fail('Read only'));
  const req = { params: { id: 'menu' }, query: { date: '2026-11-20' } };
  const first = response(); await handler(req, first);
  assert.deepEqual(first.body.data[0].cycleMeal, { ...item.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: 100 });
  meal = { ...meal, gramsPerPiece: 50 };
  const second = response(); await handler(req, second);
  assert.equal(second.body.data[0].cycleMeal.gramsPerPiece, 50);
  meal = { ...meal, mealKind: 'Breakfast', gramsPerPiece: null };
  const third = response(); await handler(req, third);
  assert.deepEqual(third.body.data[0], item);
  assert.equal(item.cycleMeal.qtyUnit, 'KG');
  item.cycleMeal.qtyUnit = 'PCS';
  item.cycleMeal.gramsPerPiece = 75;
  const retainsDatedRule = response(); await handler(req, retainsDatedRule);
  assert.deepEqual(retainsDatedRule.body.data[0], item);
  meal = { ...meal, qtyUnit: 'KG', gramsPerPiece: 0 };
  const invalidKg = response(); await handler(req, invalidKg);
  assert.deepEqual(invalidKg.body.data[0], item);
  meal = { ...meal, qtyUnit: 'PCS', gramsPerPiece: null };
  delete item.cycleMeal.qtyUnit;
  delete item.cycleMeal.gramsPerPiece;
  const incompatibleBreakfast = response(); await handler(req, incompatibleBreakfast);
  assert.deepEqual(incompatibleBreakfast.body.data[0], item);
  meal = { ...meal, mealKind: 'Main meal' };
  const fallsBackToKg = response(); await handler(req, fallsBackToKg);
  assert.deepEqual(fallsBackToKg.body.data[0].cycleMeal, { ...item.cycleMeal, qtyUnit: 'KG', gramsPerPiece: null });
  meal = { ...meal, qtyUnit: 'BOX' };
  const invalidUnit = response(); await handler(req, invalidUnit);
  assert.deepEqual(invalidUnit.body.data[0].cycleMeal, { ...item.cycleMeal, qtyUnit: 'KG', gramsPerPiece: null });
  assert.equal(item.cycleMeal.qtyUnit, undefined);
  item.mealType = 'breakfast';
  item.cycleMeal.qtyUnit = 'KG';
  meal = { ...meal, qtyUnit: 'PCS', gramsPerPiece: 50 };
  const breakfast = response(); await handler(req, breakfast);
  assert.deepEqual(breakfast.body.data[0], item);
  item.cycleMeal.gramsPerPiece = 0;
  const invalidDatedBreakfast = response(); await handler(req, invalidDatedBreakfast);
  assert.deepEqual(invalidDatedBreakfast.body.data[0].cycleMeal, { ...item.cycleMeal, qtyUnit: 'PCS', gramsPerPiece: null });
  delete item.cycleMeal.gramsPerPiece;
  meal = { ...meal, mealKind: 'Main meal', gramsPerPiece: null };
  const corruptMain = response(); await handler(req, corruptMain);
  assert.deepEqual(corruptMain.body.data[0], item);
  item.mealType = 'main';
  meal = { ...meal, mealKind: 'Breakfast', gramsPerPiece: 50 };
  const corruptBreakfast = response(); await handler(req, corruptBreakfast);
  assert.deepEqual(corruptBreakfast.body.data[0], item);
  item.cycleMeal = { ...item.cycleMeal, mealKind: 'Breakfast', qtyUnit: 'PCS', gramsPerPiece: 50 };
  meal = { id: 'library-id' };
  const incompatibleDated = response(); await handler(req, incompatibleDated);
  assert.equal(incompatibleDated.body.data[0].cycleMeal.qtyUnit, 'KG');
  assert.equal(item.cycleMeal.qtyUnit, 'PCS');
});

test('missing date and menu fail clearly', async t => {
  const invalid = response(); await handler({ params: { id: 'menu' }, query: {} }, invalid);
  assert.equal(invalid.code, 400);
  t.mock.method(Menu, 'findById', () => ({ select() { return this; }, lean: async () => null }));
  const missing = response(); await handler({ params: { id: 'menu' }, query: { date: '2026-11-20' } }, missing);
  assert.equal(missing.code, 404);
});
