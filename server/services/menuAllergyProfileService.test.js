import test from 'node:test';
import assert from 'node:assert/strict';
import Customer from '../models/Customer.js';
import { resolveMenuAllergyProfile } from './menuAllergyProfileService.js';
import { normalizeMatterAllergens } from './matterAllergens.js';

test('Matter allergens are authoritative, separate from exclusions and internal profiles', async t => {
  const find = t.mock.method(Customer, 'find', () => { throw new Error('Internal allergy lookup forbidden'); });
  const profile = await resolveMenuAllergyProfile({ customer_email: 'member@example.com', exclusions: ['Egg'], allergens: [{ id: 4, name: 'Gluten' }, { id: 19, name: 'All Nuts' }] });
  assert.deepEqual(profile, { allergies: ['Gluten', 'All Nuts'], allergiesAvailable: true, allergySource: 'matter' });
  assert.equal(find.mock.callCount(), 0);
  assert.deepEqual(await resolveMenuAllergyProfile({ allergens: [] }), { allergies: [], allergiesAvailable: true, allergySource: 'matter' });
});

test('missing or malformed Matter allergens are unknown, never a known empty list', async () => {
  for (const allergens of [undefined, null, '', {}, [null], [{ id: 4 }], ['Milk', ' ']]) {
    assert.equal(normalizeMatterAllergens(allergens), null);
    assert.equal((await resolveMenuAllergyProfile({ allergens, exclusions: ['Milk'] })).allergiesAvailable, false);
  }
  assert.deepEqual(normalizeMatterAllergens([' Milk ', { name: 'Milk' }, 'Soy']), ['Milk', 'Soy']);
  assert.deepEqual(normalizeMatterAllergens([{ title: ' ', name: 'Peanuts' }, { name: '', title: 'Milk' },
    { allergen: { title: '', name: 'Tree Nuts' } }]), ['Peanuts', 'Milk', 'Tree Nuts']);
});
