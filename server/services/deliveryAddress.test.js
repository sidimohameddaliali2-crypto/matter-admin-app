import { test } from 'node:test';
import assert from 'node:assert/strict';
import Delivery from '../models/Delivery.js';
import { structuredDeliveryAddress } from './deliveryAddress.js';

const fixture = category => ({ category, area: 'Test Zone', street: 'Test Street', building: 'Test Tower',
  floor: '0', unit: '12', additional_details: 'Side entrance', coordinates: { lat: '25.1', lng: '55.2' } });

for (const category of ['villa', 'apartment', 'office']) {
  test(`${category} retains Matter field names and compatible driver/map fields through Mongoose`, async () => {
    const result = structuredDeliveryAddress(fixture(category));
    const row = new Delivery({ customerId: 'SYNTHETIC', customerName: 'Test', scheduledTime: new Date('2026-11-20T00:00:00Z'), ...result });
    await row.validate();
    const d = row.toObject().addressDetails;
    assert.equal(d.category, category);
    assert.equal(d.sourceCategory, category);
    assert.equal(d.unit, '12');
    assert.equal(d.apartment, '12');
    assert.equal(d.additional_details, 'Side entrance');
    assert.equal(d.additionalDetails, 'Side entrance');
    assert.deepEqual(d.coordinates, { lat: 25.1, lng: 55.2 });
    assert.equal(result.zone, 'Test Zone');
    assert.equal(d.locationType, category === 'office' ? null : category === 'villa' ? 'Villa' : 'Apartment');
    if (category === 'villa') {
      assert.equal(d.building, '');
      assert.equal(d.floor, '');
      assert.ok(result.address.startsWith('Villa 12, Test Street'));
    } else assert.ok(result.address.startsWith('Test Tower, Unit 12, Floor 0'));
  });
}

test('structured addresses reject missing fields or invalid pins instead of routing an incomplete destination', () => {
  for (const category of ['villa', 'apartment', 'office']) {
    for (const key of ['area', 'street', 'unit', ...(category === 'villa' ? [] : ['building', 'floor'])]) {
      assert.throws(() => structuredDeliveryAddress({ ...fixture(category), [key]: ' ' }), { statusCode: 400 });
    }
  }
  for (const coordinates of [{ lat: '', lng: 55 }, { lat: null, lng: 55 }, { lat: 91, lng: 55 }, { lat: 25, lng: 181 }, { lat: 0, lng: 0 }]) {
    assert.throws(() => structuredDeliveryAddress({ ...fixture('villa'), coordinates }), { statusCode: 400 });
  }
  assert.throws(() => structuredDeliveryAddress(fixture('warehouse')), { statusCode: 400 });
  assert.equal(structuredDeliveryAddress({ street: 'Legacy address' }), null);
});
