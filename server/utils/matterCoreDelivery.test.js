import test from 'node:test';
import assert from 'node:assert/strict';
import { isMatterCoreDoubleDay } from './matterCoreDelivery.js';

// Week of Mon 2026-10-19: Mon 19, Tue 20, Wed 21, Thu 22, Fri 23
const MWF = ['2026-10-19', '2026-10-21', '2026-10-23'];

test('Monday and Wednesday of a Mon/Wed/Fri customer are double days', () => {
  assert.equal(isMatterCoreDoubleDay('2026-10-19', MWF), true);
  assert.equal(isMatterCoreDoubleDay('2026-10-21', MWF), true);
});

test('Friday stays a single delivery', () => {
  assert.equal(isMatterCoreDoubleDay('2026-10-23', MWF), false);
});

test('Tuesday, Thursday and the weekend are never double days', () => {
  const dates = [...MWF, '2026-10-20', '2026-10-22', '2026-10-24', '2026-10-25'];
  for (const d of ['2026-10-20', '2026-10-22', '2026-10-24', '2026-10-25']) assert.equal(isMatterCoreDoubleDay(d, dates), false);
});

test('a customer delivered every day is not double, even with one paused day', () => {
  const daily = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
  assert.equal(isMatterCoreDoubleDay('2026-10-19', daily), false);
  const tuesdayPaused = ['2026-10-19', '2026-10-21', '2026-10-22', '2026-10-23']; // Thursday still delivered
  assert.equal(isMatterCoreDoubleDay('2026-10-19', tuesdayPaused), false);
});

test('the pattern needs Monday, Wednesday and Friday all present', () => {
  assert.equal(isMatterCoreDoubleDay('2026-10-19', ['2026-10-19', '2026-10-21']), false);
  assert.equal(isMatterCoreDoubleDay('2026-10-19', ['2026-10-19', '2026-10-23']), false);
});

test('a date outside the customer\'s deliveries, or missing data, is not double', () => {
  assert.equal(isMatterCoreDoubleDay('2026-10-26', MWF), false);
  assert.equal(isMatterCoreDoubleDay('2026-10-19', null), false);
  assert.equal(isMatterCoreDoubleDay('2026-10-19', undefined), false);
  assert.equal(isMatterCoreDoubleDay('', MWF), false);
});

test('works across a month boundary', () => {
  // Mon 2026-10-26 .. Fri 2026-10-30, and Mon 2026-11-02 .. Fri 2026-11-06
  const dates = ['2026-10-26', '2026-10-28', '2026-10-30', '2026-11-02', '2026-11-04', '2026-11-06'];
  assert.equal(isMatterCoreDoubleDay('2026-10-28', dates), true);
  assert.equal(isMatterCoreDoubleDay('2026-11-02', dates), true);
  assert.equal(isMatterCoreDoubleDay('2026-11-04', dates), true);
  assert.equal(isMatterCoreDoubleDay('2026-11-06', dates), false);
});
