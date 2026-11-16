import test from 'node:test';
import assert from 'node:assert/strict';
import router from './kitchenMealEdits.js';
import Log from '../models/KitchenMealEditLog.js';
import { readMealEditLog } from '../services/kitchenMealEdits.js';
test('all meal editor/history actions require Kitchen List permission', () => {
  const middleware = router.stack[0].handle;
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  middleware({ user: { role: 'viewer' } }, res, () => assert.fail('Viewer must not edit kitchen selections'));
  assert.equal(res.code, 403);
  let allowed = false;
  middleware({ user: { role: 'kitchen' } }, res, () => { allowed = true; });
  assert.equal(allowed, true);
});
test('meal history is paginated and scoped to the permanent customer and menu', async t => {
  const menuId = '507f1f77bcf86cd799439011';
  const rows = Array.from({ length: 31 }, (_, index) => ({ _id: String(index + 100).padStart(24, '0'), actorName: 'Saved staff name' }));
  t.mock.method(Log, 'find', filter => {
    assert.deepEqual(filter, { menuId, customerId: '42' });
    return { sort(value) { assert.deepEqual(value, { _id: -1 }); return this; }, limit(value) { assert.equal(value, 31); return this; }, lean: async () => rows };
  });
  const result = await readMealEditLog({ menuId, customerId: '42' });
  assert.equal(result.entries.length, 30);
  assert.equal(result.next, rows[29]._id);
});
