import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCycleMealSnapshot } from './menuComponentSnapshot.js';
const meal = { id: 'meal', name: 'Patty', mealKind: 'Main meal', components: [{ id: 'p', type: 'Protein', name: 'Patty', exclusions: [] }] };
test('quantity settings round trip without changing components; legacy snapshots retain their shape', () => {
  assert.deepEqual(validateCycleMealSnapshot(meal), meal);
  for (const gramsPerPiece of [50, 100]) assert.equal(validateCycleMealSnapshot({ ...meal, qtyUnit: 'PCS', gramsPerPiece }).gramsPerPiece, gramsPerPiece);
  assert.equal(validateCycleMealSnapshot({ ...meal, qtyUnit: 'KG', gramsPerPiece: null }).qtyUnit, 'KG');
  assert.equal(validateCycleMealSnapshot({ ...meal, mealKind: 'Breakfast', qtyUnit: 'PCS' }).qtyUnit, 'PCS');
});
test('invalid units and zero, negative, missing or nonnumeric conversion values fail', () => {
  assert.throws(() => validateCycleMealSnapshot({ ...meal, qtyUnit: 'G' }));
  for (const gramsPerPiece of [0, -1, null, undefined, '50', Infinity]) assert.throws(() => validateCycleMealSnapshot({ ...meal, qtyUnit: 'PCS', gramsPerPiece }));
});
