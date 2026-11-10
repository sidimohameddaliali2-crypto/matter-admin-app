import { toTitleCase } from './textFormat';
import { exclusionMatchesAny } from '../constants/exclusionMatching';

test.each([['RAW ONION', 'Raw Onion'], ['ROCK MELON', 'Rock Melon'], ['ALL SEAFOOD', 'All Seafood'], ['glUTen', 'Gluten'], ["DAIRY-FREE", 'Dairy-Free'], ["CHEF’S MIX", 'Chef’s Mix'], ['', ''], [null, '']])('title case %s for display', (raw, label) => {
  expect(toTitleCase(raw)).toBe(label);
});

test('capitalization does not affect component exclusion matching', () => {
  for (const raw of ['RAW ONION', 'ROCK MELON', 'ALL NUTS']) {
    expect(exclusionMatchesAny(toTitleCase(raw), [raw])).toBe(true);
    expect(exclusionMatchesAny(raw, [toTitleCase(raw)])).toBe(true);
  }
});
