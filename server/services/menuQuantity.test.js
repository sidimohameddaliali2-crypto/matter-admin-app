import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCycleMealSnapshot } from './menuComponentSnapshot.js';
const meal = { id: 'meal', name: 'Patty', mealKind: 'Main meal', components: [{ id: 'p', type: 'Protein', name: 'Patty', exclusions: [] }] };
test('quantity settings round trip without changing components; legacy snapshots retain their shape', () => {
  assert.deepEqual(validateCycleMealSnapshot(meal), meal);
  for (const gramsPerPiece of [50, 100]) assert.equal(validateCycleMealSnapshot({ ...meal, qtyUnit: 'PCS', gramsPerPiece }).gramsPerPiece, gramsPerPiece);
  assert.equal(validateCycleMealSnapshot({ ...meal, qtyUnit: 'KG', gramsPerPiece: null }).qtyUnit, 'KG');
  assert.equal(validateCycleMealSnapshot({ ...meal, mealKind: 'Breakfast', qtyUnit: 'PCS' }).qtyUnit, 'PCS');
  assert.throws(() => validateCycleMealSnapshot({ ...meal, mealKind: 'Breakfast', qtyUnit: 'PCS', gramsPerPiece: 50 }), /do not use grams per piece/);
});
test('invalid units and zero, negative, missing or nonnumeric conversion values fail', () => {
  assert.throws(() => validateCycleMealSnapshot({ ...meal, qtyUnit: 'G' }));
  assert.throws(() => validateCycleMealSnapshot({ ...meal, gramsPerPiece: 50 }), /choose a QTY unit/);
  for (const gramsPerPiece of [0, -1, null, undefined, '50', Infinity]) assert.throws(() => validateCycleMealSnapshot({ ...meal, qtyUnit: 'PCS', gramsPerPiece }));
});

test('explicit main format requires a conversion even with a legacy breakfast category', () => {
  const { mealKind, ...legacy } = meal;
  assert.throws(() => validateCycleMealSnapshot({ ...legacy, mealFormat: 'Main', category: 'OATS', qtyUnit: 'PCS' }), /enter grams per piece/);
  assert.equal(validateCycleMealSnapshot({ ...legacy, category: 'OATS', qtyUnit: 'PCS' }).qtyUnit, 'PCS');
});
