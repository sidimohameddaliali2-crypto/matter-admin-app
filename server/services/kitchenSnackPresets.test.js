import test from 'node:test';
import assert from 'node:assert/strict';
import { snackPresetUpdate } from './kitchenSnackPresets.js';

test('one snack edit targets one map entry and cannot replace or clear other names', () => {
  const update = snackPresetUpdate({ presets: [{ snackName: ' Truffle ', C: 15, P: 10, F: 6 }] });
  assert.deepEqual(update.$set, { key: 'global', 'presetsByName.truffle': { snackName: 'Truffle', C: 15, P: 10, F: 6 } });
  assert.equal(update.$set.presetsByName, undefined);
  assert.equal(update.$unset, undefined);
  assert.deepEqual(snackPresetUpdate({ presets: [] }), { $set: { key: 'global' } });
});

test('deletion requires an explicit name, and invalid or partial macros cannot zero a saved preset', () => {
  assert.deepEqual(snackPresetUpdate({ removeKeys: ['Truffle'] }).$unset, { 'presetsByName.truffle': '' });
  for (const row of [{ snackName: 'A', C: 1 }, { snackName: 'A', C: -1, P: 2, F: 3 }, { snackName: 'A', C: '', P: 2, F: 3 }, { snackName: '$bad', C: 1, P: 2, F: 3 }]) {
    assert.throws(() => snackPresetUpdate({ presets: [row] }), error => error.statusCode === 400);
  }
  assert.throws(() => snackPresetUpdate({ presets: [{ snackName: 'A', C: 1, P: 2, F: 3 }], removeKeys: ['A'] }), /same snack/);
});

test('fallback snack presets reject 0/0/0 while allowing individual zero values', () => {
  const snackName = 'CHEESECAKE BITES (W/ MILK)';
  assert.throws(() => snackPresetUpdate({ presets: [{ snackName, C: 0, P: 0, F: 0 }] }),
    { statusCode: 400, message: /at least one non-zero macro/ });
  const update = snackPresetUpdate({ presets: [{ snackName, C: 15, P: 0, F: 0 }] });
  assert.deepEqual(update.$set['presetsByName.cheesecake bites (w/ milk)'], { snackName, C: 15, P: 0, F: 0 });
});
