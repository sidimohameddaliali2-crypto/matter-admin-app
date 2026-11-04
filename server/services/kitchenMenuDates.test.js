import test from 'node:test';
import assert from 'node:assert/strict';
import { kitchenMenuDates } from './kitchenMenuDates.js';

test('date-only response preserves selected/uploaded dates, including legacy dates outside the menu', () => {
  const menu={startDate:'2026-11-02',endDate:'2026-11-08',mainMealOptionsByDate:{'2026-11-05':{}},breakfastOptionsByDate:{'2026-11-06':[]},snackOptionsByDate:{'2026-11-05':{}}};
  assert.deepEqual(kitchenMenuDates(menu,['2026-11-01T20:00:00Z','2026-11-03',null,'invalid','2026-11-03']),['2026-11-01','2026-11-03','2026-11-05','2026-11-06']);
  assert.deepEqual(kitchenMenuDates({startDate:'2026-11-02',endDate:'2026-11-08'}),Array.from({length:7},(_,i)=>`2026-11-0${i+2}`));
});

test('full-week upload dates remain present when only Monday has customer selections', () => {
  const week = Array.from({ length: 7 }, (_, i) => `2026-11-${String(i + 9).padStart(2, '0')}`);
  const menu = { startDate: week[0], endDate: week[6] };
  assert.deepEqual(kitchenMenuDates(menu, [week[0]], week), week);
  // An existing selection must not suppress a different uploaded date or
  // extend the response to days that have no date source.
  assert.deepEqual(kitchenMenuDates(menu, [week[0]], [week[1], week[1], null, 'invalid']), week.slice(0, 2));
  assert.deepEqual(kitchenMenuDates(menu, [], [week[2]]), [week[2]]);
});
