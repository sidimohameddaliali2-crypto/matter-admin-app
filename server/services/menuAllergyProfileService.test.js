import test from 'node:test';
import assert from 'node:assert/strict';
import Customer from '../models/Customer.js';
import { resolveMenuAllergyProfile } from './menuAllergyProfileService.js';

const nutrition = { customer_id: 'person', subscription_id: 'current', customer_email: 'member@example.com' };
const mockRows = (t, rows) => t.mock.method(Customer, 'find', () => ({ select: () => ({ lean: async () => rows }) }));

test('a permanent Matter link wins over an email-only profile after renewal', async (t) => {
  mockRows(t, [
    { email: 'member@example.com', allergies: ['Egg'] },
    { matterCustomerId: 'person', matterSubscriptionId: 'old-cycle', allergies: [' Milk ', 'Milk'] },
  ]);
  assert.deepEqual(await resolveMenuAllergyProfile(nutrition), { allergies: ['Milk'], allergiesAvailable: true });
});

test('a manually linked subscription can supply allergies when the internal email differs', async (t) => {
  mockRows(t, [{ matterSubscriptionId: 'current', email: 'different@example.com', allergies: ['Peanuts'] }]);
  assert.deepEqual((await resolveMenuAllergyProfile(nutrition)).allergies, ['Peanuts']);
});

test('exact email can supply an unlinked internal profile; an empty matched allergy list is known', async (t) => {
  mockRows(t, [{ email: 'MEMBER@example.com', allergies: [] }]);
  assert.deepEqual(await resolveMenuAllergyProfile(nutrition), { allergies: [], allergiesAvailable: true });
});

test('a profile linked to another Matter customer is never used through an email match', async (t) => {
  mockRows(t, [{ matterCustomerId: 'someone-else', email: 'member@example.com', allergies: ['Egg'] }]);
  assert.deepEqual(await resolveMenuAllergyProfile(nutrition), { allergies: [], allergiesAvailable: false });
});

test('ambiguous internal profiles require correction rather than picking an arbitrary allergy list', async (t) => {
  mockRows(t, [{ matterCustomerId: 'person', allergies: [] }, { matterCustomerId: 'person', allergies: ['Egg'] }]);
  await assert.rejects(resolveMenuAllergyProfile(nutrition), { statusCode: 409 });
});
