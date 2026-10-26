import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import SlackLog from '../models/SlackLog.js';
import Order from '../models/SpaceOrder.js';
import Line from '../models/OrderLine.js';
import Menu from '../models/SpaceMenu.js';
import Price from '../models/SpacePrice.js';
import Cost from '../models/ItemCost.js';
import Invoice from '../models/Invoice.js';
import InvoiceLine from '../models/InvoiceLine.js';
import Waste from '../models/WasteLog.js';
import { normalizePartnerLines, validatePartnerOrder, partnerUnitPrice } from './partnerOrderValidation.js';
import { partnerReportScope } from './partnerReportScope.js';

// Notification delivery is disabled before the route's email module loads.
delete process.env.BREVO_API_KEY;
delete process.env.ORDER_NOTIFY_EMAIL;
const { default: partnerRouter } = await import('../routes/partnerPortal.js');
const { default: adminRouter } = await import('../routes/adminPartners.js');

const SPACE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ITEM = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ORDER = 'cccccccccccccccccccccccc';
const DAY = '2099-01-05';
const doc = (fields) => ({ ...fields, toObject() { return { ...this }; } });
const query = (value) => ({
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  populate() { return this; }, sort() { return this; }, select() { return this; }
});
async function call(router, method, path, request = {}) {
  const route = router.stack.find(s => s.route?.path === path && s.route.methods[method]).route;
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await route.stack.at(-1).handle({ query: {}, params: {}, body: {}, partner: { _id: SPACE, minimumOrder: 100 }, ...request }, response);
  await new Promise(resolve => setImmediate(resolve));
  return response;
}
function fixtures(t, status = 'submitted') {
  // Tests never send real order alerts or touch the Slack audit collection.
  t.mock.method(axios, 'post', async () => ({ status: 200, data: { ok: true, channel: 'fixture-channel', ts: '1.0' } }));
  t.mock.method(SlackLog, 'create', async () => ({}));
  const item = doc({ _id: ITEM, name: 'Meal', price: 20, sellingPrice: null, isAvailable: true });
  const order = doc({ _id: ORDER, space: { _id: SPACE }, status, deliveryDate: new Date(DAY), acknowledgedAt: new Date(), async save() { writes++; } });
  let writes = 0;
  let storedLines = [doc({ order: ORDER, menuItem: ITEM, quantity: 10 })];
  t.mock.method(Order, 'find', () => query([order]));
  t.mock.method(Order, 'findOne', () => query(order));
  t.mock.method(Order, 'findById', () => query(order));
  t.mock.method(Order, 'create', async fields => { writes++; return doc({ ...fields, _id: ORDER, status: 'draft' }); });
  t.mock.method(Order, 'updateMany', async () => { throw new Error('Reads must not lock orders'); });
  t.mock.method(Line, 'find', () => query(storedLines));
  t.mock.method(Line, 'findOneAndUpdate', async (filter, update) => {
    writes++;
    storedLines = storedLines.filter(l => String(l.menuItem) !== filter.menuItem);
    storedLines.push(doc({ order: ORDER, menuItem: filter.menuItem, quantity: update.quantity }));
  });
  t.mock.method(Line, 'deleteOne', async filter => { writes++; storedLines = storedLines.filter(l => l.menuItem !== filter.menuItem); });
  t.mock.method(Menu, 'find', () => query([{ menuItem: item }]));
  t.mock.method(Price, 'aggregate', async () => []);
  t.mock.method(Price, 'findOne', () => query(null));
  t.mock.method(Cost, 'aggregate', async () => []);
  t.mock.method(Invoice, 'find', () => query([]));
  t.mock.method(InvoiceLine, 'distinct', async () => []);
  return { item, order, writes: () => writes, lines: () => storedLines };
}

test('reading an overdue partner order does not change status or prevent admin invoicing', async t => {
  const f = fixtures(t);
  f.order.deliveryDate = new Date('2020-01-06');
  Line.find.mock.mockImplementation(() => query([]));
  const response = await call(partnerRouter, 'get', '/orders');
  assert.equal(response.code, 200);
  assert.equal(f.order.status, 'submitted');
  assert.equal(response.body.data[0].editable, false);
  assert.equal(f.writes(), 0);
});

test('a cancelled order cannot be resubmitted or invoiced', async t => {
  const f = fixtures(t, 'cancelled');
  for (const [router, method, path] of [[partnerRouter, 'post', '/orders/:id/submit'], [adminRouter, 'patch', '/orders/:orderId/lock']]) {
    const response = await call(router, method, path);
    assert.equal(response.code, 400);
  }
  assert.equal(f.order.status, 'cancelled');
  assert.equal(f.writes(), 0);
});

test('a replacement order excludes cancelled history and creates a fresh draft', async t => {
  const f = fixtures(t, 'cancelled');
  Order.findOne.mock.mockImplementation(filter => {
    assert.deepEqual(filter.status, { $ne: 'cancelled' });
    return query(null);
  });
  const response = await call(partnerRouter, 'post', '/orders', { body: { deliveryDate: DAY, lines: [{ menuItemId: ITEM, quantity: 5 }] } });
  assert.equal(response.code, 200);
  assert.equal(response.body.data.status, 'draft');
  assert.equal(f.order.status, 'cancelled');
});

test('submitted order edits enforce minimum spend before changing lines or acknowledgement', async t => {
  const f = fixtures(t);
  const ack = f.order.acknowledgedAt;
  const response = await call(partnerRouter, 'post', '/orders', { body: { deliveryDate: DAY, lines: [{ menuItemId: ITEM, quantity: 1 }] } });
  assert.equal(response.code, 400);
  assert.match(response.body.message, /Minimum order/);
  assert.equal(f.lines()[0].quantity, 10);
  assert.equal(f.order.acknowledgedAt, ack);
  assert.equal(f.writes(), 0);
});

test('valid submitted edits stay submitted without requiring a kitchen acknowledgement', async t => {
  const f = fixtures(t);
  const previousAcknowledgement = f.order.acknowledgedAt;
  const response = await call(partnerRouter, 'post', '/orders', { body: { deliveryDate: DAY, lines: [{ menuItemId: ITEM, quantity: 5 }] } });
  assert.equal(response.code, 200);
  assert.equal(f.lines()[0].quantity, 5);
  assert.equal(f.order.status, 'submitted');
  assert.equal(f.order.acknowledgedAt, previousAcknowledgement);
});

test('submission and cancellation notify open kitchen pages for the order date', async t => {
  const f = fixtures(t, 'draft');
  const events = [];
  const app = { get: () => ({ emit: (...args) => events.push(args) }) };
  assert.equal((await call(partnerRouter, 'post', '/orders/:id/submit', { app })).code, 200);
  assert.deepEqual(events[0], ['partner:ordersChanged', { date: DAY }]);
  assert.equal((await call(partnerRouter, 'post', '/orders/:id/cancel', { app })).code, 200);
  assert.equal(f.order.status, 'cancelled');
  assert.deepEqual(events[1], ['partner:ordersChanged', { date: DAY }]);
});

test('submitted edits cannot remove the final item even with no minimum', async t => {
  const f = fixtures(t);
  const response = await call(partnerRouter, 'post', '/orders', { partner: { _id: SPACE, minimumOrder: 0 }, body: { deliveryDate: DAY, lines: [{ menuItemId: ITEM, quantity: 0 }] } });
  assert.equal(response.code, 400);
  assert.equal(f.writes(), 0);
});

test('bad quantities, malformed IDs and duplicate entries are rejected before writes', async t => {
  const f = fixtures(t, 'draft');
  for (const quantity of [-1, 0.5, 'bad', '', '  ', null, true, Infinity]) {
    assert.throws(() => normalizePartnerLines([{ menuItemId: ITEM, quantity }]), /whole numbers/);
  }
  assert.throws(() => normalizePartnerLines([{ menuItemId: 'unknown', quantity: 1 }]), /ID/);
  assert.throws(() => normalizePartnerLines([{ menuItemId: ITEM, quantity: 1 }, { menuItemId: ITEM, quantity: 2 }]), /only once/);
  const response = await call(partnerRouter, 'post', '/orders', { body: { deliveryDate: DAY, lines: [{ menuItemId: ITEM, quantity: 0.5 }] } });
  assert.equal(response.code, 400);
  assert.equal(f.writes(), 0);
});

test('missing, unassigned, disabled and out-of-season items cannot be saved or submitted', async t => {
  const f = fixtures(t, 'draft');
  for (const state of ['missing', 'disabled', 'future', 'expired']) {
    f.item.isAvailable = state !== 'disabled';
    f.item.availableFrom = state === 'future' ? new Date('2099-02-01') : null;
    f.item.availableTo = state === 'expired' ? new Date('2099-01-04') : null;
    Menu.find.mock.mockImplementation(() => query(state === 'missing' ? [] : [{ menuItem: f.item }]));
    const body = { deliveryDate: DAY, lines: [{ menuItemId: ITEM, quantity: 5 }] };
    for (const path of ['/orders', '/orders/:id/submit']) {
      const response = await call(partnerRouter, 'post', path, { body });
      assert.equal(response.code, 400, state);
    }
  }
  assert.equal(f.writes(), 0);
});

test('base, selling and custom prices agree between menu and order validation, including zero', async t => {
  const f = fixtures(t, 'draft');
  for (const [sellingPrice, override, expected] of [[null, undefined, 20], [25, undefined, 25], [25, 12, 12], [25, 0, 0]]) {
    f.item.sellingPrice = sellingPrice;
    Price.aggregate.mock.mockImplementation(async () => override === undefined ? [] : [{ _id: ITEM, price: override }]);
    const menu = await call(partnerRouter, 'get', '/menu', { query: { date: DAY } });
    const validated = await validatePartnerOrder({ spaceId: SPACE, deliveryDate: DAY, lines: [{ menuItemId: ITEM, quantity: 5 }] });
    assert.equal(menu.body.data[0].price, expected);
    assert.equal(validated.totalAmount, expected * 5);
    assert.equal(partnerUnitPrice(f.item, override), expected);
  }
});

test('valid drafts submit using the base price and inclusive menu availability dates', async t => {
  const f = fixtures(t, 'draft');
  f.item.availableFrom = new Date(DAY);
  f.item.availableTo = new Date(DAY);
  const response = await call(partnerRouter, 'post', '/orders/:id/submit');
  assert.equal(response.code, 200);
  assert.equal(f.order.status, 'submitted');
  assert.equal(f.writes(), 1);
});

test('successful submission sends one Slack alert and repeat submission sends none', async t => {
  const f = fixtures(t, 'draft');
  const before = process.env.SLACK_BOT_TOKEN;
  const enabled = process.env.ENABLE_SLACK_NOTIFICATIONS;
  process.env.SLACK_BOT_TOKEN = 'fixture-token';
  process.env.ENABLE_SLACK_NOTIFICATIONS = '1';
  t.after(() => {
    if (before === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = before;
    if (enabled === undefined) delete process.env.ENABLE_SLACK_NOTIFICATIONS; else process.env.ENABLE_SLACK_NOTIFICATIONS = enabled;
  });
  assert.equal((await call(partnerRouter, 'post', '/orders/:id/submit')).code, 200);
  assert.equal(axios.post.mock.callCount(), 1);
  assert.equal(SlackLog.create.mock.calls[0].arguments[0].partnerOrderId, ORDER);
  assert.equal((await call(partnerRouter, 'post', '/orders/:id/submit')).code, 400);
  assert.equal(axios.post.mock.callCount(), 1);
  assert.equal(f.order.status, 'submitted');
});

test('a Slack failure cannot reject a successfully submitted order', async t => {
  const f = fixtures(t, 'draft');
  axios.post.mock.mockImplementation(async () => { throw new Error('Fixture Slack failure'); });
  const response = await call(partnerRouter, 'post', '/orders/:id/submit');
  assert.equal(response.code, 200);
  assert.equal(f.order.status, 'submitted');
});

for (const [path, body] of [
  ['/orders', { deliveryDate: '2026-10-26', lines: [{ menuItemId: ITEM, quantity: 5 }] }],
  ['/orders/:id/submit', {}],
  ['/orders/:id/cancel', {}],
]) {
  for (const closed of [false, true]) {
    test(`${path}: ${closed ? 'rejects' : 'allows'} changes at Monday's shared selection cutoff`, async t => {
      const f = fixtures(t, 'draft');
      f.order.deliveryDate = new Date('2026-10-26T00:00:00Z');
      t.mock.timers.enable({ apis: ['Date'], now: Date.parse(closed ? '2026-10-23T11:01:00Z' : '2026-10-23T11:00:59.999Z') });
      const response = await call(partnerRouter, 'post', path, { body });
      assert.equal(response.code, closed ? 400 : 200);
      if (closed) assert.equal(f.writes(), 0);
    });
  }
}

test('deadline locking still prevents cancellation when reading orders no longer writes status', async t => {
  const f = fixtures(t);
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 23, 16).getTime() });
  f.order.deliveryDate = new Date(2026, 9, 26);
  assert.ok(f.order.deliveryDate - Date.now() > 48 * 60 * 60 * 1000);
  const response = await call(partnerRouter, 'post', '/orders/:id/cancel');
  assert.equal(response.code, 400);
  assert.match(response.body.message, /deadline/);
  assert.equal(f.writes(), 0);
});

test('legacy auto-locked orders can be invoiced, and a failed snapshot write can be retried', async t => {
  const f = fixtures(t, 'locked');
  Line.find.mock.mockImplementation(() => query([doc({ menuItem: f.item, quantity: 5 })]));
  const invoices = [];
  const snapshotIds = new Set();
  Invoice.find.mock.mockImplementation(() => query(invoices));
  InvoiceLine.distinct.mock.mockImplementation(async () => [...snapshotIds]);
  t.mock.method(Invoice, 'findOne', async filter => invoices.find(i => i.type === filter.type));
  t.mock.method(Invoice, 'create', async fields => {
    const invoice = doc({ ...fields, _id: fields.type, async save() {} });
    invoices.push(invoice);
    return invoice;
  });
  t.mock.method(InvoiceLine, 'deleteMany', async filter => snapshotIds.delete(filter.invoice));
  let fail = true;
  t.mock.method(InvoiceLine, 'insertMany', async snapshots => {
    if (snapshots[0].invoice === 'matter' && fail) { fail = false; throw new Error('Fixture: interrupted statement write'); }
    snapshotIds.add(snapshots[0].invoice);
  });
  const first = await call(adminRouter, 'patch', '/orders/:orderId/lock');
  assert.equal(first.code, 500);
  const retry = await call(adminRouter, 'patch', '/orders/:orderId/lock');
  assert.equal(retry.code, 200);
  assert.equal(invoices.length, 2);
  assert.deepEqual([...snapshotIds].sort(), ['matter', 'partner']);
  assert.equal(f.order.status, 'locked');
  assert.equal((await call(adminRouter, 'patch', '/orders/:orderId/lock')).code, 400);
});

test('admin order list derives invoicing from both invoice snapshots, not locked status', async t => {
  const f = fixtures(t, 'locked');
  Line.find.mock.mockImplementation(() => query([]));
  assert.equal((await call(adminRouter, 'get', '/orders/all')).body.data[0].invoiced, false);
  Invoice.find.mock.mockImplementation(() => query([{ _id: 'p', order: ORDER, type: 'partner' }, { _id: 'm', order: ORDER, type: 'matter' }]));
  InvoiceLine.distinct.mock.mockImplementation(async () => ['p', 'm']);
  assert.equal((await call(adminRouter, 'get', '/orders/all')).body.data[0].invoiced, true);
  assert.equal(f.writes(), 0);
});

test('financial report scope uses inclusive delivery dates and preserves an empty result', async t => {
  fixtures(t);
  Order.find.mock.mockImplementation(filter => {
    assert.equal(filter.space, SPACE);
    assert.equal(filter.deliveryDate.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(filter.deliveryDate.$lte.toISOString(), '2026-01-31T23:59:59.999Z');
    return query([]);
  });
  const scope = await partnerReportScope({ from: '2026-01-01', to: '2026-01-31', spaceId: SPACE });
  assert.deepEqual(scope.invoiceOrderFilter, { order: { $in: [] } });
  await assert.rejects(partnerReportScope({ from: 'invalid' }), /Invalid report date/);
  await assert.rejects(partnerReportScope({ from: '2026-02-01', to: '2026-01-01' }), /start date/);
});

test('admin consolidated report applies the delivery-day order IDs to totals and top items', async t => {
  fixtures(t);
  Order.find.mock.mockImplementation(() => query([{ _id: ORDER }]));
  let financialMatch, itemMatch, wasteMatch;
  t.mock.method(Invoice, 'aggregate', async pipeline => { financialMatch = pipeline[0].$match; return []; });
  t.mock.method(InvoiceLine, 'aggregate', async pipeline => { itemMatch = pipeline.find(s => s.$match).$match; return []; });
  t.mock.method(Waste, 'aggregate', async pipeline => { wasteMatch = pipeline[0].$match; return []; });
  const response = await call(adminRouter, 'get', '/reports/consolidated', { query: { from: '2026-01-01', to: '2026-01-31' } });
  assert.equal(response.code, 200);
  assert.deepEqual(financialMatch.order, { $in: [ORDER] });
  assert.deepEqual(itemMatch['inv.order'], { $in: [ORDER] });
  assert.equal(wasteMatch.deliveryDate.$lte.toISOString(), '2026-01-31T23:59:59.999Z');
});

test('partner and per-space reports filter invoices and order counts by the same period', async t => {
  fixtures(t);
  const invoiceFilters = [];
  Invoice.find.mock.mockImplementation(filter => { invoiceFilters.push(filter); return query([]); });
  t.mock.method(InvoiceLine, 'aggregate', async () => []);
  t.mock.method(Waste, 'aggregate', async () => []);
  t.mock.method(Waste, 'find', () => query([]));
  let countsMatch;
  t.mock.method(Order, 'aggregate', async pipeline => { countsMatch = pipeline[0].$match; return []; });
  const range = { from: '2026-01-01', to: '2026-01-31' };
  assert.equal((await call(partnerRouter, 'get', '/reports', { query: range })).code, 200);
  assert.equal((await call(adminRouter, 'get', '/reports/space/:spaceId', { query: range, params: { spaceId: SPACE } })).code, 200);
  for (const filter of invoiceFilters) assert.deepEqual(filter.order, { $in: [ORDER] });
  assert.equal(countsMatch.deliveryDate.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
});
