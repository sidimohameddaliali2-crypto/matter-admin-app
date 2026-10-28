import test from 'node:test';
import assert from 'node:assert/strict';
import { hasKitchenPreset } from './kitchenMacroValidation.js';

test('missing, zero, negative and ambiguous presets cannot authorize auto-assignment', () => {
  assert.equal(hasKitchenPreset('Snack', {}), false);
  assert.equal(hasKitchenPreset('Snack', { snack: { C: 0, P: 0, F: 0 } }), false);
  assert.equal(hasKitchenPreset('Snack', { snack: { C: 10, P: -1, F: 2 } }), false);
  assert.equal(hasKitchenPreset('Snack', { snack: { C: 10, P: 1, F: 2 } }), true);
});
