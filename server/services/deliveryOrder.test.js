import test from 'node:test';
import assert from 'node:assert/strict';
import { orderRevision, validateOrder } from './deliveryOrder.js';
const rows = [{ _id: 'a', routeOrder: 0, status: 'assigned' }, { _id: 'b', routeOrder: 1, status: 'assigned' }];
test('accepts a complete reordered route without mutating it', () => {
  assert.equal(validateOrder(rows, ['b', 'a'], orderRevision(rows)), null);
  assert.equal(rows[0].routeOrder, 0);
});
test('rejects missing, repeated and foreign delivery IDs', () => {
  for (const ids of [['a'], ['a', 'a'], ['a', 'c'], null]) assert.ok(validateOrder(rows, ids, orderRevision(rows)));
});
test('rejects concurrent route and status changes', () => {
  const revision = orderRevision(rows);
  assert.ok(validateOrder([{ ...rows[0], status: 'delivered' }, rows[1]], ['b', 'a'], revision));
  assert.ok(validateOrder([{ ...rows[0], routeOrder: 2 }, rows[1]], ['b', 'a'], revision));
  assert.ok(validateOrder([...rows, { _id: 'c' }], ['b', 'a'], revision));
});
test('revision does not depend on query ordering', () => {
  assert.equal(orderRevision(rows), orderRevision([...rows].reverse()));
});
