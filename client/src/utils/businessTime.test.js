import { businessComponentsToUtcDate, toBusinessComponents, formatBusinessDateInput } from './businessTime';

test('Dubai windows agree with kitchen labels even across the UTC date boundary', () => {
  const instant = businessComponentsToUtcDate('2026-10-23', '03:30');
  expect(instant.toISOString()).toBe('2026-10-22T23:30:00.000Z');
  expect(toBusinessComponents(instant)).toMatchObject({ year: 2026, month: 9, day: 23, hours: 3, minutes: 30 });
  expect(formatBusinessDateInput(instant)).toBe('2026-10-23');
});
