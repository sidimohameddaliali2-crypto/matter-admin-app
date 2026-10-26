import test from 'node:test';
import assert from 'node:assert/strict';
import SpaceOrder from '../models/SpaceOrder.js';
import OrderLine from '../models/OrderLine.js';
import { getPartnerKitchenOrders } from './partnerKitchenOrders.js';

const date = '2026-10-31';
const query = value => ({ then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }, populate() { return this; }, sort() { return this; } });
function fixture(t) {
  const orders = [
    { _id: 'new', status: 'submitted', deliveryDate: date, space: { businessName: 'Cafe A' }, acknowledgedAt: null },
    { _id: 'invoiced', status: 'locked', deliveryDate: date, space: { businessName: 'Gym B' } },
    { _id: 'cancelled', status: 'cancelled', deliveryDate: date },
    { _id: 'draft', status: 'draft', deliveryDate: date },
    { _id: 'other-day', status: 'submitted', deliveryDate: '2026-11-01' },
  ];
  const item = { _id: 'meal', name: 'Chicken Bowl', mealType: 'bowl' };
  const lines = [
    { order: 'new', menuItem: item, quantity: 3 },
    { order: 'invoiced', menuItem: item, quantity: 2 },
    { order: 'cancelled', menuItem: item, quantity: 100 },
    { order: 'draft', menuItem: item, quantity: 100 },
    { order: 'other-day', menuItem: item, quantity: 100 },
  ];
  t.mock.method(SpaceOrder, 'find', filter => {
    assert.deepEqual(filter.status, { $in: ['submitted', 'locked'] });
    assert.equal(filter.deliveryDate.$gte.toISOString(), `${date}T00:00:00.000Z`);
    assert.equal(filter.deliveryDate.$lt.toISOString(), '2026-11-01T00:00:00.000Z');
    return query(orders.filter(o => filter.status.$in.includes(o.status) && new Date(o.deliveryDate) >= filter.deliveryDate.$gte && new Date(o.deliveryDate) < filter.deliveryDate.$lt));
  });
  t.mock.method(OrderLine, 'find', filter => query(lines.filter(l => filter.order.$in.includes(l.order))));
  return { orders, lines };
}

test('new submitted orders are kitchen work immediately, with no acknowledgement or invoice required', async t => {
  fixture(t);
  const result = await getPartnerKitchenOrders(date);
  assert.deepEqual(result.orders.map(o => o.id), ['new', 'invoiced']);
  assert.equal(result.orderCount, 2);
  assert.equal(result.totalQuantity, 5);
  assert.equal(result.counts[0].quantity, 5);
  assert.equal(result.orders[0].lines[0].quantity, 3);
});

test('edits and cancellation change counting and kitchen list together, without stale copies', async t => {
  const f = fixture(t);
  f.lines[0].quantity = 8;
  assert.equal((await getPartnerKitchenOrders(date)).totalQuantity, 10);
  f.orders[0].status = 'cancelled';
  const result = await getPartnerKitchenOrders(date);
  assert.equal(result.totalQuantity, 2);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].id, 'invoiced');
});

test('historically acknowledged orders are included once alongside new unacknowledged orders', async t => {
  const f = fixture(t);
  f.orders[0].acknowledgedAt = new Date();
  assert.equal((await getPartnerKitchenOrders(date)).totalQuantity, 5);
});

test('deleted catalog items remain visible for review instead of silently removing ordered portions', async t => {
  const f = fixture(t);
  f.lines[0].menuItem = null;
  f.lines[0]._id = 'deleted-line';
  const result = await getPartnerKitchenOrders(date);
  assert.equal(result.orders[0].lines[0].needsReview, true);
  assert.equal(result.totalQuantity, 5);
});

test('invalid dates and invalid stored quantities cannot produce a cooking count', async t => {
  const f = fixture(t);
  await assert.rejects(getPartnerKitchenOrders('2026-02-31'), /valid delivery date/);
  f.lines[0].quantity = 1.5;
  await assert.rejects(getPartnerKitchenOrders(date), /invalid quantity/);
});
