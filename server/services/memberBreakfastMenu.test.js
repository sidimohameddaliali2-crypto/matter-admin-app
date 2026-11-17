import test from 'node:test';
import assert from 'node:assert/strict';
import SpaceMenu from '../models/SpaceMenu.js';
import SpacePrice from '../models/SpacePrice.js';
import MemberOrder from '../models/MemberOrder.js';
import MemberOrderLine from '../models/MemberOrderLine.js';
delete process.env.BREVO_API_KEY;
delete process.env.ORDER_NOTIFY_EMAIL;
const {default: router} = await import('../routes/memberPortal.js');
const date = '2099-01-05';
const query = value => ({sort() {return this;}, populate() {return this;}, then(resolve, reject) {return Promise.resolve(value).then(resolve, reject);}});
const breakfast = () => ({_id: 'meal', name: 'Egg Toast', mealType: 'breakfast', source: 'menu-selection', sellingPrice: 12, price: 12,
  availableFrom: new Date(date), availableTo: new Date('2099-01-07'), availableDates: [new Date(date), new Date('2099-01-07')], isAvailable: true});
async function call(method, path, request = {}) {
  const response = {code: 200, status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}};
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
  await route.stack.at(-1).handle({query: {}, params: {id: 'order'}, member: {_id: 'member', partner: {_id: 'partner', minimumOrder: 20}}, ...request}, response);
  return response;
}

test('the shared member menu respects non-consecutive breakfast serving dates', async t => {
  const item = breakfast(); item.toObject = () => ({...item});
  t.mock.method(SpaceMenu, 'find', () => query([{menuItem: item}]));
  t.mock.method(SpacePrice, 'aggregate', async () => []);
  assert.equal((await call('get', '/menu', {query: {date}})).body.data[0].price, 12);
  assert.equal((await call('get', '/menu', {query: {date: '2099-01-06'}})).body.data.length, 0);
});

for (const [override, minimum, expected] of [[null, 20, 200], [0, 1, 400]]) {
  test(`member breakfast submission uses the configured price and respects override ${override}`, async t => {
    const order = {_id: 'order', status: 'draft', deliveryDate: new Date(date), async save() {}};
    t.mock.method(MemberOrder, 'findOne', async () => order);
    t.mock.method(MemberOrderLine, 'find', () => query([{menuItem: breakfast(), quantity: 2}]));
    t.mock.method(SpacePrice, 'findOne', () => query(override === null ? null : {price: override}));
    const result = await call('post', '/orders/:id/submit', {member: {_id: 'member', partner: {_id: 'partner', minimumOrder: minimum}}});
    assert.equal(result.code, expected);
  });
}

test('member submission rejects breakfast on dates where it is not served', async t => {
  const order = {_id: 'order', status: 'draft', deliveryDate: new Date('2099-01-06'), async save() {throw new Error('No write expected');}};
  t.mock.method(MemberOrder, 'findOne', async () => order);
  t.mock.method(MemberOrderLine, 'find', () => query([{menuItem: breakfast(), quantity: 1}]));
  assert.equal((await call('post', '/orders/:id/submit')).code, 400);
});
