import test from 'node:test';
import assert from 'node:assert/strict';
import { kitchenMenuDates } from './kitchenMenuDates.js';

test('date-only response preserves selected/uploaded dates, including legacy dates outside the menu', () => {
  const menu={startDate:'2026-11-02',endDate:'2026-11-08',mainMealOptionsByDate:{'2026-11-05':{}},breakfastOptionsByDate:{'2026-11-06':[]},snackOptionsByDate:{'2026-11-05':{}}};
  assert.deepEqual(kitchenMenuDates(menu,['2026-11-01T20:00:00Z','2026-11-03',null,'invalid','2026-11-03']),['2026-11-01','2026-11-03','2026-11-05','2026-11-06']);
  assert.deepEqual(kitchenMenuDates({startDate:'2026-11-02',endDate:'2026-11-08'}),Array.from({length:7},(_,i)=>`2026-11-0${i+2}`));
});
