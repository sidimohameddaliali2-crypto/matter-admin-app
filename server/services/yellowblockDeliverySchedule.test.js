import assert from 'node:assert/strict';
import test from 'node:test';
import { toScheduledDelivery } from './yellowblockDeliverySchedule.js';

const today = '2026-11-23';
const order = {
  legacyResourceId: '10001',
  name: '#101',
  displayFulfillmentStatus: 'UNFULFILLED',
  shippingAddress: { name: 'Example Customer', address1: 'Example Street', city: 'Dubai' },
  customAttributes: [],
};

test('the recorded Shopify metafield overrides older checkout dates', () => {
  const delivery = toScheduledDelivery({
    ...order,
    customAttributes: [{ key: 'delivery_date', value: '2026-12-02' }],
    deliveryDate: { value: today },
  }, today);

  assert.deepEqual(delivery, {
    id: '10001', name: '#101', date: today,
    customerName: 'Example Customer', address: 'Example Street, Dubai',
  });
});

test('checkout attributes support recorded ISO and formatted dates', () => {
  const getDate = (...customAttributes) => toScheduledDelivery({ ...order, customAttributes }, today)?.date;
  assert.equal(getDate({ key: 'delivery_date', value: '2026-12-04' }), '2026-12-04');
  assert.equal(getDate({ key: 'Delivery Date', value: '04/12/2026' }), '2026-12-04');
  assert.equal(getDate({ key: 'Delivery Date', value: '12/04/2026' }, { key: 'Date Format', value: 'MM/DD/YYYY' }), '2026-12-04');
  assert.equal(getDate({ key: 'Delivery-Date', value: '2026/12/04' }), '2026-12-04');
  assert.equal(getDate({ key: 'Delivery Date', value: '31/11/2026' }), undefined);
});

test('only upcoming pending deliveries appear on the schedule', () => {
  const scheduledOrder = { ...order, deliveryDate: { value: '2026-11-24' } };
  assert.ok(toScheduledDelivery({ ...scheduledOrder, displayFulfillmentStatus: 'PARTIALLY_FULFILLED' }, today));
  for (const changes of [
    { displayFulfillmentStatus: 'FULFILLED' },
    { cancelledAt: '2026-11-20T14:00:00Z' },
    { test: true },
    { deliveryDate: { value: '2026-11-22' } },
    { deliveryDate: null, createdAt: '2026-11-24T14:00:00Z' },
    { customAttributes: [{ key: 'Order Type', value: 'Store Pickup' }] },
  ]) {
    assert.equal(toScheduledDelivery({ ...scheduledOrder, ...changes }, today), null);
  }
});
