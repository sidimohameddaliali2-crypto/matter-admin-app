import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { resolveMatterDeliveryAddress, matterMealContract } from './matterSubscriptionContract.js';
import matter, { buildNutritionResult } from './matterApiService.js';
import { buildMatterDeliverySnapshot, importMatterDeliveriesForDate } from './matterDeliveryImportService.js';
import { compareMatterDelivery } from './matterDeliveryComparison.js';
import { serializeDelivery } from '../routes/externalDeliveryApi.js';
import Delivery from '../models/Delivery.js';
import Customer from '../models/Customer.js';
import matterRouter from '../routes/matterApi.js';

const old = { id: 1, status: 'active', building: 'Old', current_delivery_address: false };
const current = { id: 2, status: 'active', building: 'Current', current_delivery_address: true, street: 'Street', additional_details: 'Door instruction', category: 'Apartment', coordinates: { lat: 25, lng: 55 } };
const sub = { customer_id: 'fixture-person', subscription_id: 'fixture', name: 'Fixture', customer_addresses: [old, current], delivery_window: { label: 'By 3 AM' }, plan: { name: 'Custom', meal_frequency: 3 }, snacks_per_day: 0, breakfast_included: false };

test('current address identity is shared by kitchen nutrition and delivery proposals', () => {
  const nutrition = buildNutritionResult(sub);
  const snapshot = buildMatterDeliverySnapshot(sub, '2026-10-20');
  assert.equal(nutrition.delivery_address_resolution.address.id, 2);
  assert.equal(snapshot.addressId, '2');
  assert.equal(snapshot.addressDetails.street, 'Street');
  assert.equal(snapshot.addressDetails.additionalDetails, 'Door instruction');
  assert.equal(snapshot.addressDetails.locationType, 'Apartment');
  assert.equal(snapshot.scheduledTime.toISOString(), '2026-10-19T23:00:00.000Z');
  assert.ok(nutrition.source_fetched_at);
  assert.equal(nutrition.meal_contract.mealsPerDay, 3);
});

test('address ambiguity never falls back to order, primary status or completeness', () => {
  assert.equal(resolveMatterDeliveryAddress([old, { ...current, current_delivery_address: false }]).status, 'unresolved');
  assert.equal(resolveMatterDeliveryAddress([{ ...old, current_delivery_address: true }, current]).reason, 'multiple-current-addresses');
  assert.equal(resolveMatterDeliveryAddress([]).reason, 'no-active-address');
  assert.equal(resolveMatterDeliveryAddress([old]).reason, 'single-active-address');
  assert.equal(buildMatterDeliverySnapshot({ ...sub, customer_addresses: [old, { ...current, current_delivery_address: false }] }, '2026-10-20'), null);
});

test('missing, blank and unsupported address details remain distinguishable', () => {
  const snapshot = buildMatterDeliverySnapshot({ ...sub, customer_addresses: [{ ...current, street: '', floor: undefined, category: 'Office' }] }, '2026-10-20');
  assert.equal(snapshot.addressDetails.street, '');
  assert.equal(snapshot.addressDetails.floor, null);
  assert.equal(snapshot.addressDetails.locationType, null);
  assert.equal(snapshot.addressDetails.sourceCategory, 'Office');
  assert.equal(matterMealContract({}).mealsPerDay, null);
  assert.equal(matterMealContract({}).breakfastIncluded, null);
  assert.equal(matterMealContract(sub).snacksPerDay, 0);
});

test('manual pin reuse requires matching customer pin source and exact address identity/text', () => {
  const baseline = buildMatterDeliverySnapshot(sub, '2026-10-20');
  const customer = { gpsLocation: { addressId: '2', address: baseline.address, source: 'manual', lat: 25.1, lng: 55.1 } };
  assert.equal(buildMatterDeliverySnapshot(sub, '2026-10-20', customer).gpsLocation.lat, 25.1);
  for (const change of [{ addressId: '1' }, { addressId: null }, { address: 'Another building' }, { source: 'google' }]) {
    assert.equal(buildMatterDeliverySnapshot(sub, '2026-10-20', { gpsLocation: { ...customer.gpsLocation, ...change } }).gpsLocation.lat, 25);
  }
});

test('fresh kitchen reads follow the permanent customer across renewals without stale cache fallback', async () => {
  const original = { get: matter.getSubscription, list: matter.listSubscriptions };
  let calls = 0;
  matter.listSubscriptions = async ({ customerId }) => { assert.equal(customerId, 'fixture-person'); return { data: [{ subscription_id: 'fixture' }] }; };
  matter.getSubscription = async (id) => { calls++; assert.equal(id, 'fixture'); return { data: { ...sub, customer_addresses: calls === 1 ? [old] : [current] } }; };
  try {
    const identity = { customerId: 'fixture-person', subscriptionId: 'expired' };
    assert.equal((await matter.getKitchenNutrition(identity)).delivery_address_resolution.address.id, 1);
    assert.equal((await matter.getKitchenNutrition(identity)).delivery_address_resolution.address.id, 2);
    assert.equal(calls, 2);
    matter.getSubscription = async () => { throw new Error('upstream unavailable'); };
    await assert.rejects(matter.getKitchenNutrition(identity), /unavailable/);
    matter.getSubscription = async () => ({ data: { ...sub, subscription_id: 'unrelated' } });
    await assert.rejects(matter.getKitchenNutrition(identity), /current Matter subscription/);
    matter.listSubscriptions = async () => ({ data: [] });
    await assert.rejects(matter.getKitchenNutrition(identity), /missing or ambiguous/);
  } finally { matter.getSubscription = original.get; matter.listSubscriptions = original.list; }
});

test('comparison reports before/after without modifying jobs, corrections or history', () => {
  const proposed = buildMatterDeliverySnapshot(sub, '2026-10-20');
  for (const status of ['pending', 'assigned', 'on_route', 'delivered']) {
    const saved = { _id: 'existing', ...proposed, status, addressId: '1', gpsLocation: { lat: 25.1, lng: 55.1 } };
    const before = JSON.stringify(saved);
    const options = { date: '2026-10-20', fetchedAt: 'fixture' };
    const result = compareMatterDelivery(saved, proposed, options);
    assert.equal(result.action, 'review-only');
    assert.equal(result.effectiveState, 'UNKNOWN');
    assert.ok(result.conflicts.some((conflict) => conflict.field === 'gpsLocation'));
    assert.equal(result.protected, ['on_route', 'delivered'].includes(status));
    assert.deepEqual(compareMatterDelivery(saved, proposed, options), result);
    assert.equal(JSON.stringify(saved), before);
  }
});

test('reimport reports existing-job conflicts without writes or another stop', async () => {
  const original = { discover: matter.findSubscriptionsWithDeliveryOnDate, find: Delivery.findOne, update: Delivery.updateOne, create: Delivery.create };
  matter.findSubscriptionsWithDeliveryOnDate = async () => [sub];
  Delivery.findOne = (query) => {
    assert.equal(query.matterSubscriptionId, 'fixture');
    assert.equal(query.matterSource, undefined);
    return { select: async () => ({ _id: 'existing', customerName: 'Fixture', status: 'pending', addressId: '1' }) };
  };
  Delivery.updateOne = Delivery.create = async () => assert.fail('must not write');
  try {
    const result = await importMatterDeliveriesForDate('2026-10-20');
    assert.equal(result.alreadyExisted, 1);
    assert.equal(result.created, 0);
    assert.ok(result.comparisons[0].conflicts.some((conflict) => conflict.field === 'addressId'));
  } finally { matter.findSubscriptionsWithDeliveryOnDate = original.discover; Delivery.findOne = original.find; Delivery.updateOne = original.update; Delivery.create = original.create; }
});

test('external API distinguishes saved delivery and unverified profile values', () => {
  const payload = serializeDelivery({ _id: 'fixture', customerId: 'customer', ...buildMatterDeliverySnapshot(sub, '2026-10-20') }, new Map());
  assert.equal(payload.matterSubscriptionId, 'fixture');
  assert.equal(payload.addressDetails.street, 'Street');
  assert.equal(payload.sources.delivery.type, 'saved-delivery-snapshot');
  assert.equal(payload.sources.meals.verifiedAgainstMatter, false);
  assert.equal(payload.customer.mealPerDay, null);
});


test('service worker never substitutes cached kitchen inputs when offline; driver fallback remains available', async () => {
  const listeners = {};
  let offline = false, cacheReads = 0, response;
  const cached = { status: 200, fixture: 'cached driver delivery' };
  vm.runInNewContext(fs.readFileSync(new URL('../../client/public/service-worker.js', import.meta.url), 'utf8'), {
    self: { addEventListener: (name, callback) => { listeners[name] = callback; } },
    location: { origin: 'https://fixture.invalid' }, URL, console,
    fetch: async (_request, options) => { if (offline) throw new Error('offline'); return options; },
    caches: { match: async () => { cacheReads++; return cached; } },
  });
  const request = (path) => listeners.fetch({ request: { url: `https://fixture.invalid${path}`, method: 'GET' }, respondWith: (promise) => { response = promise; } });
  for (const path of ['/api/matter/subscriptions/kitchen-inputs', '/api/matter/subscriptions/delivery-on-date', '/api/matter/subscriptions/fixture/delivery-comparison']) {
    offline = false; request(path); assert.equal((await response).cache, 'no-store');
    offline = true; request(path); await assert.rejects(response, /offline/);
  }
  assert.equal(cacheReads, 0);
  request('/api/deliveries');
  assert.equal(await response, cached);
  assert.equal(cacheReads, 1);
});


test('bounded comparison route includes multiple linked orders and Dubai-day bounds without writes', async () => {
  const original = { get: matter.getSubscription, customer: Customer.findOne, deliveries: Delivery.find, create: Delivery.create, update: Customer.updateOne };
  const handler = matterRouter.stack.find((layer) => layer.route?.path === '/subscriptions/:id/delivery-comparison').route.stack.at(-1).handle;
  const jobs = ['pending', 'on_route', 'delivered'].map((status, i) => ({ _id: `job-${i}`, status, addressId: 'old' }));
  matter.getSubscription = async () => ({ data: { ...sub, delivery_schedule: [{ date: '2026-10-20', status: 'active' }] } });
  Customer.findOne = (query) => { assert.deepEqual(query, { matterSubscriptionId: 'fixture' }); return { select: async () => ({ customerId: 'linked', mealPerDay: 2, mealPlan: 'Manual custom' }) }; };
  Delivery.find = (query) => {
    assert.equal(query.scheduledTime.$gte.toISOString(), '2026-10-19T20:00:00.000Z');
    assert.equal(query.scheduledTime.$lt.toISOString(), '2026-10-20T20:00:00.000Z');
    assert.deepEqual(query.$or, [{ matterSubscriptionId: 'fixture' }, { customerId: 'linked' }]);
    return { lean: async () => jobs };
  };
  Delivery.create = Customer.updateOne = async () => assert.fail('comparison cannot write');
  const res = { set: () => res, status: (code) => { res.statusCode = code; return res; }, json: (body) => { res.body = body; } };
  try {
    await handler({ params: { id: 'fixture' }, query: { date: '2026-10-20' } }, res);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.rosterDisposition, 'review-multiple-orders');
    assert.equal(res.body.data.profileComparison.conflict, true);
    assert.equal(res.body.data.deliveries.length, 3);
    assert.equal(res.body.data.eligibility, 'active');
    assert.equal(res.body.data.effectiveState, 'UNKNOWN');
    assert.equal(res.body.data.deliveries[1].protected, true);
  } finally { matter.getSubscription = original.get; Customer.findOne = original.customer; Delivery.find = original.deliveries; Delivery.create = original.create; Customer.updateOne = original.update; }
});


test('missing delivery windows stay unknown rather than inventing a 6 AM target', () => {
  assert.equal(buildMatterDeliverySnapshot({ ...sub, delivery_window: null }, '2026-10-20').scheduledTime, null);
});


test('kitchen email lookup takes priority over stale saved links and rejects uncertain matches', async () => {
  const original = { get: matter.getSubscription, list: matter.listSubscriptions };
  const current = { ...sub, subscription_id: 'renewed', customer_id: 'same-customer', email: 'fixture@example.invalid' };
  matter.listSubscriptions = async (params) => {
    if (params.customerId) assert.equal(params.customerId, 'same-customer');
    else assert.equal(params.email, 'fixture@example.invalid');
    return { data: [current] };
  };
  matter.getSubscription = async (id) => { assert.equal(id, 'renewed'); return { data: current }; };
  try {
    const input = { email: ' Fixture@Example.Invalid ', subscriptionId: 'stale', customerId: 'same-customer' };
    assert.equal((await matter.getKitchenNutrition(input)).subscription_id, 'renewed');
    await assert.rejects(matter.getKitchenNutrition({ ...input, customerId: 'another' }), /another/);
    for (const rows of [[], [current, current]]) {
      matter.listSubscriptions = async () => ({ data: rows });
      await assert.rejects(matter.getKitchenNutrition(input), /missing or ambiguous/);
    }
    matter.listSubscriptions = async () => ({ data: [{ ...current, email: 'other@example.invalid' }] });
    await assert.rejects(matter.getKitchenNutrition({ email: input.email }), /email does not match/);
    matter.listSubscriptions = async () => { throw new Error('upstream unavailable'); };
    await assert.rejects(matter.getKitchenNutrition(input), /unavailable/);
  } finally { matter.getSubscription = original.get; matter.listSubscriptions = original.list; }
});


test('preparation supplies Matter inputs with the same sweep and no repeated detail reads', async () => {
  const original = { list: matter.listAllSubscriptions, get: matter.getSubscription };
  let calls = 0;
  matter.listAllSubscriptions = async () => [{ ...sub, email: 'fixture@example.invalid', subscription_status: 'active', cycle_end_date: '2026-10-30' }];
  matter.getSubscription = async () => { calls++; return { data: { ...sub, email: 'fixture@example.invalid', macros: { protein: 150, carbohydrates: 150, fat: null }, delivery_schedule: [{ date: '2026-10-22', status: 'active' }] } }; };
  try {
    const rows = await matter.findSubscriptionsWithDeliveryOnDate('2026-10-22', { includeKitchenInputs: true });
    assert.equal(calls, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kitchen_inputs.customer_email, 'fixture@example.invalid');
    assert.equal(rows[0].kitchen_inputs.macros.fat, null);
    assert.equal(rows[0].kitchen_inputs.delivery_address_resolution.address.id, 2);
    assert.ok(rows[0].kitchen_inputs.source_fetched_at);
    const ordinary = await matter.findSubscriptionsWithDeliveryOnDate('2026-10-22');
    assert.equal(ordinary[0].kitchen_inputs, undefined);
  } finally { matter.listAllSubscriptions = original.list; matter.getSubscription = original.get; }
});


test('legacy storage emails are recovered through Matter permanent identity and verified by website email', async () => {
  const original = { get: matter.getSubscription, list: matter.listSubscriptions };
  const current = { ...sub, subscription_id: 'renewed', customer_id: 'permanent', email: 'website@example.invalid' };
  const calls = [];
  matter.listSubscriptions = async (params) => {
    calls.push(params);
    return { data: params.email === 'internal@example.invalid' ? [] : [current] };
  };
  matter.getSubscription = async (id) => { assert.equal(id, 'renewed'); return { data: current }; };
  try {
    const result = await matter.getKitchenNutrition({ email: 'internal@example.invalid', subscriptionId: 'expired', customerId: 'permanent' });
    assert.equal(result.customer_email, 'website@example.invalid');
    assert.equal(result.customer_name, 'Fixture');
    assert.equal(calls[0].customerId, 'permanent');
    assert.equal(calls.length, 1);
    matter.getSubscription = async () => ({ data: { ...current, customer_id: 'unrelated' } });
    await assert.rejects(matter.getKitchenNutrition({ email: 'internal@example.invalid', customerId: 'permanent' }), /conflict|identity/);
  } finally { matter.getSubscription = original.get; matter.listSubscriptions = original.list; }
});
