import { isWithinRenewalWindow } from './subscriptionRenewal';

const now = new Date('2026-11-10T08:00:00Z');
test.each([['2026-11-13',true],['2026-11-12',true],['2026-11-11',true],['2026-11-10',true],['2026-11-14',false],['2026-12-10',false],['2026-11-09',false],[null,false],['',false],['invalid',false],['2026-02-30',false]])('renewal eligibility for end date %s is %s', (end, expected) => {
  expect(isWithinRenewalWindow(end, now)).toBe(expected);
});

test('renewal window follows Dubai midnight regardless of browser timezone', () => {
  expect(isWithinRenewalWindow('2026-11-14', new Date('2026-11-10T19:59:59Z'))).toBe(false);
  expect(isWithinRenewalWindow('2026-11-14', new Date('2026-11-10T20:00:00Z'))).toBe(true);
  expect(isWithinRenewalWindow('2026-11-10', new Date('2026-11-10T20:00:00Z'))).toBe(false);
});
