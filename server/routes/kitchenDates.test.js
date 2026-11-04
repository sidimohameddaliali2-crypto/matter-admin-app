import test from 'node:test';
import assert from 'node:assert/strict';
import router from './menus.js';
import Menu from '../models/WeeklyMenu.js';
import Item from '../models/MenuItem.js';
import Record from '../models/MenuSelectionRecord.js';
import matter from '../services/matterApiService.js';

const handler = router.stack.find(layer => layer.route?.path === '/:id/kitchen-dates').route.stack.at(-1).handle;
const menuId = '507f1f77bcf86cd799439011';
const response = () => ({ status(code) { this.code = code; return this; }, set() { return this; }, json(body) { this.body = body; return this; } });

test('date endpoint combines partial selections and the full linked upload without reading full meals or running assignment', async t => {
  const itemIds = Array.from({ length: 7 }, (_, i) => String(i + 12).padStart(24, '0'));
  const week = Array.from({ length: 7 }, (_, i) => `2026-11-${String(i + 9).padStart(2, '0')}`);
  t.mock.method(Menu, 'findById', () => ({ select(fields) {
    assert.ok(fields.includes('meals.items'));
    return { lean: async () => ({ startDate: week[0], endDate: week[6], meals: [{ items: itemIds }] }) };
  } }));
  t.mock.method(Record, 'aggregate', async pipeline => {
    assert.equal(String(pipeline[0].$match.weeklyMenuId), menuId);
    return [{ _id: new Date(week[0]) }];
  });
  const read = t.mock.method(Item, 'distinct', async (field, filter) => {
    assert.equal(field, 'itemDate'); assert.deepEqual(filter, { _id: { $in: itemIds } });
    return week.map(day => new Date(day));
  });
  t.mock.method(Item, 'find', () => assert.fail('Do not load full uploaded meals'));
  t.mock.method(Record, 'find', () => assert.fail('Do not load full customer selections'));
  t.mock.method(Record, 'updateOne', () => assert.fail('Date discovery cannot assign meals'));
  t.mock.method(matter, 'client', () => assert.fail('Date discovery cannot call Matter'));
  const res = response(); await handler({ params: { id: menuId } }, res);
  assert.deepEqual(res.body, { success: true, data: week }); assert.equal(read.mock.callCount(), 1);
});

test('an empty upload keeps the menu-range fallback without scanning unrelated MenuItems', async t => {
  t.mock.method(Menu, 'findById', () => ({ select() { return this; }, lean: async () => ({ startDate: '2026-11-09', endDate: '2026-11-10', meals: [] }) }));
  t.mock.method(Record, 'aggregate', async () => []);
  t.mock.method(Item, 'distinct', () => assert.fail('No linked IDs: do not scan the collection'));
  const res = response(); await handler({ params: { id: menuId } }, res);
  assert.deepEqual(res.body.data, ['2026-11-09', '2026-11-10']);
});
