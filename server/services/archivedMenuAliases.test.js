import test from 'node:test';
import assert from 'node:assert/strict';
import { excludeRecreatedArchivedAliases } from './archivedMenuAliases.js';

const meal = { date: new Date('2026-10-23'), mealType: 'main', mealName: 'Dish', quantity: 2 };
const alias = { _id: 'new-copy', weeklyMenuId: 'menu', email: 'old@example.invalid', selectedMeals: [meal], dayNotes: [], skippedDays: [] };
const retained = { _id: 'kept', weeklyMenuId: 'menu', matterCustomerId: '42' };
const archive = { retainedSelectionId: 'kept', matterCustomerId: '42', original: { ...alias, _id: 'archived-copy' } };

test('an approved alias recreated under a new ID is suppressed without changing any stored row', () => {
  const records = [alias, retained];
  const before = JSON.stringify(records);
  assert.deepEqual(excludeRecreatedArchivedAliases(records, [archive]), [retained]);
  assert.equal(JSON.stringify(records), before);
});
test('unapproved or newly changed choices, notes and pauses stay visible', () => {
  for (const change of [
    { selectedMeals: [{ ...meal, quantity: 3 }] }, { selectedMeals: [{ ...meal, remark: 'New kitchen instruction' }] },
    { dayNotes: [{ date: '2026-10-23', note: 'New note' }] }, { skippedDays: [{ date: '2026-10-23' }] },
    { matterCustomerId: 'other' }, { weeklyMenuId: 'other-menu' },
  ]) {
    const updated = { ...alias, ...change };
    assert.equal(excludeRecreatedArchivedAliases([updated, retained], [archive]).includes(updated), true);
  }
  assert.deepEqual(excludeRecreatedArchivedAliases([alias, retained], []), [alias, retained]);
});
test('an archive cannot suppress a record if the retained Matter account is missing or has changed', () => {
  assert.deepEqual(excludeRecreatedArchivedAliases([alias], [archive]), [alias]);
  assert.equal(excludeRecreatedArchivedAliases([alias, { ...retained, matterCustomerId: 'wrong' }], [archive]).includes(alias), true);
});
