import test from 'node:test';
import assert from 'node:assert/strict';
import { snackCatalogue, resolveSnack, snackBlocked, eligibleSnackPools, preferredSnackPool, snackRuleConflict } from './kitchenSnackPolicy.js';

const catalogue = snackCatalogue({ muffin: { snackName: 'Funfetti Muffins', C: 15, P: 10, F: 6 }, ball: { snackName: 'Bliss Ball', C: 18, P: 10, F: 7 }, missing: { snackName: 'Unknown macros' } });
const rule = { blockedSnacks: [{ key: 'funfetti muffins', name: 'Funfetti Muffins' }] };
test('canonical names match ingredient suffixes, never arbitrary substrings', () => {
  assert.equal(snackBlocked('FUNFETTI MUFFINS (W/ SOY)', rule, catalogue), true);
  assert.equal(snackBlocked('Mini Funfetti Muffins', rule, catalogue), false);
  assert.equal(resolveSnack('muffin', catalogue).key, 'funfetti muffins');
  const ambiguous = snackCatalogue({ a: { snackName: 'A', aliases: ['same'] }, b: { snackName: 'B', aliases: ['same'] } });
  assert.equal(resolveSnack('same', ambiguous), null);
});
test('rules, dietary exclusions and preset macros all filter candidates before rotation fallback', () => {
  const pools = { first: [{ name: 'Funfetti Muffins' }, { name: 'Unknown macros' }], second: [{ name: 'Bliss Ball' }] };
  const result = eligibleSnackPools(pools, { rule, catalogue, excluded: () => false });
  assert.deepEqual(result.first, []);
  assert.equal(preferredSnackPool(result, 0)[0].name, 'Bliss Ball');
  assert.equal(preferredSnackPool(result, 1)[0].name, 'Bliss Ball');
  const none = eligibleSnackPools(pools, { rule, catalogue, excluded: () => true });
  assert.deepEqual(preferredSnackPool(none, 0), []);
});
test('only blocked auto-assigned snacks are flagged; no saved choices or macros are modified', () => {
  const meal = { mealType: 'snack', mealName: 'Funfetti Muffins', isAutoAssigned: true, snackMacros: { C: 15 } };
  const before = JSON.stringify(meal);
  assert.equal(snackRuleConflict(meal, rule, catalogue), true);
  assert.equal(snackRuleConflict({ ...meal, isAutoAssigned: false }, rule, catalogue), false);
  assert.equal(snackRuleConflict({ ...meal, mealType: 'breakfast' }, rule, catalogue), false);
  assert.equal(JSON.stringify(meal), before);
});

test('legacy unique preset macro fallback remains available without broadening name-based blocks', () => {
  const rows = snackCatalogue({ muffins: { C: 15, P: 10, F: 6 } });
  const pools = eligibleSnackPools({ first: [{ name: 'Banana Muffins' }], second: [] }, { catalogue: rows,
    rule: { blockedSnacks: [{ key: 'muffins' }] }, excluded: () => false });
  assert.equal(pools.first.length, 1, 'Macro fallback does not imply that two dishes have the same identity');
});
