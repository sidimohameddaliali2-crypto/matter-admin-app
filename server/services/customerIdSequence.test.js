import test from 'node:test';
import assert from 'node:assert/strict';
import { nextCustomerId, isEmailDerivedCustomerId } from './customerIdSequence.js';

test('only exact legacy email forms qualify, leaving existing numbered and unrelated IDs intact', () => {
  for (const id of ['person', 'person@example.invalid', 'person_example_invalid']) assert.equal(isEmailDerivedCustomerId(id, 'person@example.invalid'), true);
  for (const id of ['CUST-000124477', 'another-person', 'matter_123', '']) assert.equal(isEmailDerivedCustomerId(id, 'person@example.invalid'), false);
});
const fixture = (floor = 124477) => {
  let reserved = 0;
  const customers = { aggregate: () => ({ toArray: async () => [{ value: floor }] }), findOne: async () => null };
  const counters = {
    updateOne: async (_filter, update) => { reserved = Math.max(reserved, update.$max.value); },
    findOneAndUpdate: async () => ({ value: { value: ++reserved } }),
  };
  return { customers, counters, get reserved() { return reserved; }, set floor(value) { floor = value; } };
};
test('concurrent reservations are unique, monotonic, and preserve unused reservations', async () => {
  const state = fixture();
  const values = await Promise.all(Array.from({ length: 40 }, () => nextCustomerId(state)));
  assert.equal(new Set(values).size, 40);
  assert.equal(values[0], 'CUST-000124478');
  assert.equal(values.at(-1), 'CUST-000124517');
  assert.equal(await nextCustomerId(state), 'CUST-000124518');
  state.floor = 124600;
  assert.equal(await nextCustomerId(state), 'CUST-000124601');
});
test('a colliding manual number is skipped instead of being reused', async () => {
  const state = fixture();
  state.customers.findOne = async ({ customerId }) => customerId === 'CUST-000124478' ? { _id: 'taken' } : null;
  assert.equal(await nextCustomerId(state), 'CUST-000124479');
});
