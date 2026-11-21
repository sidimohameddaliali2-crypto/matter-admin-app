import test from 'node:test';
import assert from 'node:assert/strict';
import router from './menus.js';
import Menu from '../models/WeeklyMenu.js';
import Item from '../models/MenuItem.js';
import Record from '../models/MenuSelectionRecord.js';
const handler = router.stack.find(layer => layer.route?.path === '/:id/kitchen-components').route.stack.at(-1).handle;
const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

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

test('missing date and menu fail clearly', async t => {
  const invalid = response(); await handler({ params: { id: 'menu' }, query: {} }, invalid);
  assert.equal(invalid.code, 400);
  t.mock.method(Menu, 'findById', () => ({ select() { return this; }, lean: async () => null }));
  const missing = response(); await handler({ params: { id: 'menu' }, query: { date: '2026-11-20' } }, missing);
  assert.equal(missing.code, 404);
});
