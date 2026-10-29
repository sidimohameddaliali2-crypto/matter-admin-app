import { snackPresetChanges } from './kitchenSnackPresetChanges';
import { toSnackPresetState, toBreakfastPresetState } from './kitchenData';

test('an edit sends only changed entries, leaving concurrent unrelated presets untouched', () => {
  const before = { truffle: { snackName: 'Truffle', C: 15, P: 10, F: 6 }, bites: { snackName: 'Bites', C: 20, P: 5, F: 7 } };
  const edited = { ...before, truffle: { ...before.truffle, C: 18 } };
  expect(snackPresetChanges(before, edited)).toEqual({ presets: [edited.truffle], removeKeys: [] });
  expect(snackPresetChanges(before, { bites: before.bites })).toEqual({ presets: [], removeKeys: ['truffle'] });
});

test('snapshot presets normalize identically to fetched presets and preserve flat breakfast defaults', () => {
  expect(toSnackPresetState({ presetsByName: { ' TRUFFLE ': { snackName: 'Truffle', C: 15, P: 10, F: 6 } } }).presetsByName.truffle.C).toBe(15);
  expect(toBreakfastPresetState({ breakfastName: 'Oats', C: 25, P: 30, F: 10, V: 80 }).C).toBe(25);
});
