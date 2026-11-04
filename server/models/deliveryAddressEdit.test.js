import test from 'node:test';
import assert from 'node:assert/strict';
import Delivery from './Delivery.js';
import { sanitizeDeliveryAddressEdit } from '../services/deliveryAddressEdit.js';

const original = {
  address: 'Old villa', addressId: '1840',
  addressDetails: { city: 'Dubai', area: 'Al Garhoud', apartment: 'Villa 91' },
  gpsLocation: { lat: 25.236661, lng: 55.356334 }
};

test('text-only address edits invalidate old breakdown, identity and pin', () => {
  assert.deepEqual(sanitizeDeliveryAddressEdit(original, { address: 'School' }), {
    address: 'School', addressId: null, addressDetails: null, gpsLocation: null
  });
});
test('resubmitted old details and coordinates do not survive a new address', () => {
  const result = sanitizeDeliveryAddressEdit(original, {
    ...structuredClone(original), address: 'School',
    gpsLocation: { ...original.gpsLocation, link: 'https://maps.app.goo.gl/new' }
  });
  assert.equal(result.addressDetails, null);
  assert.equal(result.addressId, null);
  assert.deepEqual(result.gpsLocation, { link: 'https://maps.app.goo.gl/new' });
});
test('no-op and unrelated edits preserve the existing destination', () => {
  for (const fields of [{ address: ' Old villa ' }, { notes: 'Security office' }]) {
    assert.deepEqual(sanitizeDeliveryAddressEdit(original, { ...fields }), fields);
  }
});
test('explicit replacement breakdown, address identity and new coordinates survive', () => {
  const fields = { address: 'School', addressId: 'new', addressDetails: { building: 'School' }, gpsLocation: { lat: 25.22, lng: 55.32 } };
  assert.deepEqual(sanitizeDeliveryAddressEdit(original, structuredClone(fields)), fields);
});
test('dotted replacements become complete new nested values without old fields', () => {
  const result = sanitizeDeliveryAddressEdit(original, {
    address: 'School', 'addressDetails.building': 'School', 'gpsLocation.lat': 25.22, 'gpsLocation.lng': 55.32
  });
  assert.deepEqual(result.addressDetails, { building: 'School' });
  assert.deepEqual(result.gpsLocation, { lat: 25.22, lng: 55.32 });
  assert.equal(result['gpsLocation.lat'], undefined);
});

async function queryHook(update, op = 'findOneAndUpdate') {
  const saved = Delivery.findOne;
  Delivery.findOne = () => ({ select: () => ({ lean: async () => structuredClone(original) }) });
  try {
    const query = Delivery[op]({ _id: '6ae064b755d3bda765da0683' }, update);
    await new Promise((resolve, reject) => Delivery.schema.s.hooks.execPre(op, query, [], (error) => error ? reject(error) : resolve()));
    return query.getUpdate();
  } finally { Delivery.findOne = saved; }
}
test('dispatcher plain updates and uploaded $set updates both run the cleanup', async () => {
  for (const update of [{ address: 'School' }, { $set: { address: 'School' } }]) {
    const result = await queryHook(update);
    assert.equal(result.$set.addressDetails, null);
    assert.equal(result.$set.gpsLocation, null);
    assert.equal(result.$set.addressId, null);
  }
});
test('save/validate cleans old address fields before applying zone rules', async () => {
  const saved = Delivery.findById;
  Delivery.findById = () => ({ select: () => ({ lean: async () => structuredClone(original) }) });
  try {
    const doc = Delivery.hydrate({ _id: '6ae064b755d3bda765da0683', ...original, customerId: 'C1', customerName: 'Test', scheduledTime: new Date(), company: 'Matter' });
    doc.address = 'School';
    await doc.validate();
    assert.equal(doc.toObject().addressDetails, null);
    assert.equal(doc.toObject().gpsLocation, null);
    assert.equal(doc.addressId, null);
  } finally { Delivery.findById = saved; }
});
test('bulk address changes clear dependent values without an old-record lookup', async () => {
  const result = await queryHook({ $set: { address: 'School' } }, 'updateMany');
  assert.equal(result.$set.addressDetails, null);
  assert.equal(result.$set.gpsLocation, null);
});
