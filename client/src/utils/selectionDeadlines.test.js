import { FIXED_SELECTION_DEADLINES, isPastSelectionDeadline } from './selectionDeadlines';

test.each([
  ['2026-10-26', '2026-10-23T11:00:59.999Z'],
  ['2026-10-27', '2026-10-24T20:00:59.999Z'],
  ['2026-10-28', '2026-10-25T20:00:59.999Z'],
  ['2026-10-29', '2026-10-26T20:00:59.999Z'],
  ['2026-10-30', '2026-10-27T20:00:59.999Z'],
  ['2026-10-31', '2026-10-27T20:00:59.999Z'],
  ['2026-11-01', '2026-10-27T20:00:59.999Z'],
])('%s: partner and menu selection lock immediately after the Dubai cutoff minute', (date, cutoff) => {
  expect(isPastSelectionDeadline(date, FIXED_SELECTION_DEADLINES, new Date(cutoff))).toBe(false);
  expect(isPastSelectionDeadline(date, FIXED_SELECTION_DEADLINES, new Date(Date.parse(cutoff) + 1))).toBe(true);
});

test('missing legacy rules keep today open using the Dubai date', () => {
  const now = new Date('2026-10-25T21:00:00Z'); // Monday 01:00 Dubai.
  expect(isPastSelectionDeadline('2026-10-25', [], now)).toBe(true);
  expect(isPastSelectionDeadline('2026-10-26', [], now)).toBe(false);
});
