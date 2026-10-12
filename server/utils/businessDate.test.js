// Run under more than one OS timezone to prove server-TZ independence, e.g.:
//   TZ=UTC node --test utils/businessDate.test.js
//   TZ=America/New_York node --test utils/businessDate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  businessDayStart,
  toBusinessDateKey,
  getBusinessDayBounds,
  resolveBusinessDateRange,
  isDateKey
} from './businessDate.js';

process.env.LOCAL_TIMEZONE_OFFSET_MINUTES = '240';

const iso = (d) => d.toISOString();
const inRange = (instant, { start, endExclusive }) => instant >= start && instant < endExclusive;

test('Tuesday 03:00 Dubai (Mon 23:00Z) is inside a date-only Tuesday report and grouped under Tuesday', () => {
  const stop = new Date('2026-10-12T23:00:00.000Z');
  const range = resolveBusinessDateRange('2026-10-13', '2026-10-13');
  assert.ok(inRange(stop, range));
  assert.equal(toBusinessDateKey(stop), '2026-10-13');
});

test('date-only day includes local 00:00 and excludes the following local 00:00', () => {
  const range = resolveBusinessDateRange('2026-10-13', '2026-10-13');
  assert.equal(iso(range.start), '2026-10-12T20:00:00.000Z');
  assert.equal(iso(range.endExclusive), '2026-10-13T20:00:00.000Z');
  assert.ok(inRange(new Date('2026-10-12T20:00:00.000Z'), range));
  assert.ok(inRange(new Date('2026-10-13T19:59:59.999Z'), range));
  assert.ok(!inRange(new Date('2026-10-13T20:00:00.000Z'), range));
  assert.ok(!inRange(new Date('2026-10-12T19:59:59.999Z'), range));
});

test('month and year boundaries', () => {
  assert.equal(iso(businessDayStart('2027-01-01')), '2026-12-31T20:00:00.000Z');
  assert.equal(toBusinessDateKey(new Date('2026-12-31T22:00:00.000Z')), '2027-01-01');
  assert.equal(toBusinessDateKey(new Date('2026-12-31T19:59:59.999Z')), '2026-12-31');
  assert.equal(iso(businessDayStart('2026-03-01')), '2026-02-28T20:00:00.000Z');
  assert.equal(toBusinessDateKey(new Date('2026-10-31T21:00:00.000Z')), '2026-11-01');
});

test('multi-day range covers every whole business day through the end date', () => {
  const range = resolveBusinessDateRange('2026-01-31', '2026-02-02');
  assert.equal(iso(range.start), '2026-01-30T20:00:00.000Z');
  assert.equal(iso(range.endExclusive), '2026-02-02T20:00:00.000Z');
  assert.ok(inRange(new Date('2026-02-02T19:00:00.000Z'), range)); // Feb 2, 23:00 Dubai
  assert.ok(!inRange(new Date('2026-02-02T23:00:00.000Z'), range)); // Feb 3, 03:00 Dubai
});

test('full ISO timestamps (what the Reports page sends) are exact instants, not re-anchored to the server day', () => {
  // Browser in Dubai: local 00:00 and 23:59:59.999 of Oct 13, serialized.
  const range = resolveBusinessDateRange('2026-10-12T20:00:00.000Z', '2026-10-13T19:59:59.999Z');
  assert.equal(iso(range.start), '2026-10-12T20:00:00.000Z');
  assert.equal(iso(range.endExclusive), '2026-10-13T20:00:00.000Z');
  // Next morning's 03:00 Dubai stop must NOT leak in (the old setHours bug).
  assert.ok(!inRange(new Date('2026-10-13T23:00:00.000Z'), range));
});

test('daily grouping reconciles with the same business-day bounds', () => {
  const stops = [
    '2026-10-12T20:00:00.000Z', // Oct 13 00:00 Dubai
    '2026-10-12T23:00:00.000Z', // Oct 13 03:00
    '2026-10-13T02:00:00.000Z', // Oct 13 06:00
    '2026-10-13T19:59:59.000Z', // Oct 13 23:59
    '2026-10-13T23:00:00.000Z' // Oct 14 03:00
  ].map((s) => new Date(s));
  const range = resolveBusinessDateRange('2026-10-13', '2026-10-14');
  const perDay = {};
  stops.filter((s) => inRange(s, range)).forEach((s) => {
    const key = toBusinessDateKey(s);
    perDay[key] = (perDay[key] || 0) + 1;
    const bounds = getBusinessDayBounds(key);
    assert.ok(s >= bounds.startOfDay && s < bounds.endOfDayExclusive);
  });
  assert.deepEqual(perDay, { '2026-10-13': 4, '2026-10-14': 1 });
});

test('getBusinessDayBounds accepts a date key or an instant and agrees', () => {
  const fromKey = getBusinessDayBounds('2026-10-13');
  const fromInstant = getBusinessDayBounds(new Date('2026-10-12T23:00:00.000Z'));
  assert.equal(iso(fromKey.startOfDay), iso(fromInstant.startOfDay));
  assert.equal(iso(fromKey.endOfDayExclusive), iso(fromInstant.endOfDayExclusive));
});

test('rejects invalid or inverted ranges', () => {
  assert.equal(resolveBusinessDateRange('2026-10-14', '2026-10-13'), null);
  assert.equal(resolveBusinessDateRange('not-a-date', '2026-10-13'), null);
  assert.equal(resolveBusinessDateRange('2026-02-30', '2026-03-01'), null);
  assert.equal(resolveBusinessDateRange('', '2026-10-13'), null);
  assert.equal(isDateKey('2026-02-30'), false);
  assert.equal(isDateKey('2026-02-28'), true);
});

// ---- time-of-day edits (issue #5) ----
import { parseTimeOfDay, setBusinessTimeOfDay } from './businessDate.js';

test('Tuesday 03:00 Dubai (Mon 23:00Z) edited to 05:00 stays Tuesday: 2026-10-13T01:00:00Z', () => {
  const out = setBusinessTimeOfDay(new Date('2026-10-12T23:00:00.000Z'), '05:00');
  assert.equal(iso(out), '2026-10-13T01:00:00.000Z');
  assert.equal(toBusinessDateKey(out), '2026-10-13');
});

test('boundary times keep the delivery on its own business day', () => {
  // A delivery on Tue Oct 13 (Dubai), stored 03:00 local = Mon 23:00Z.
  const stored = new Date('2026-10-12T23:00:00.000Z');
  const expected = {
    '00:00': '2026-10-12T20:00:00.000Z',
    '03:59': '2026-10-12T23:59:00.000Z',
    '04:00': '2026-10-13T00:00:00.000Z',
    '23:59': '2026-10-13T19:59:00.000Z'
  };
  for (const [time, utc] of Object.entries(expected)) {
    const out = setBusinessTimeOfDay(stored, time);
    assert.equal(iso(out), utc, time);
    assert.equal(toBusinessDateKey(out), '2026-10-13', `${time} must stay on Oct 13`);
  }
});

test('month and year boundaries: first day of the month/year, early morning', () => {
  // Jan 1 2027 02:00 Dubai = Dec 31 2026 22:00Z
  const newYear = new Date('2026-12-31T22:00:00.000Z');
  assert.equal(iso(setBusinessTimeOfDay(newYear, '06:00')), '2027-01-01T02:00:00.000Z');
  assert.equal(toBusinessDateKey(setBusinessTimeOfDay(newYear, '00:00')), '2027-01-01');
  // Mar 1 2026 01:00 Dubai = Feb 28 21:00Z
  const march = new Date('2026-02-28T21:00:00.000Z');
  assert.equal(iso(setBusinessTimeOfDay(march, '05:30')), '2026-03-01T01:30:00.000Z');
});

test('repeated edits never shift the date', () => {
  let t = new Date('2026-10-12T23:00:00.000Z'); // Oct 13 03:00 Dubai
  for (const time of ['05:00', '00:30', '03:00', '23:59', '04:00', '00:00', '05:00']) {
    t = setBusinessTimeOfDay(t, time);
    assert.equal(toBusinessDateKey(t), '2026-10-13', `after ${time}`);
  }
});

test('invalid times are rejected (and valid H:mm is accepted)', () => {
  for (const bad of ['', '9', '24:00', '25:00', '09:60', '09:75', '6:00 AM', 'abc', '12:5', null, undefined, '-1:00']) {
    assert.equal(parseTimeOfDay(bad), null, String(bad));
    assert.throws(() => setBusinessTimeOfDay(new Date('2026-10-13T01:00:00Z'), bad), /Invalid time/);
  }
  assert.deepEqual(parseTimeOfDay('9:05'), { hours: 9, minutes: 5 });
  assert.deepEqual(parseTimeOfDay(' 23:59 '), { hours: 23, minutes: 59 });
});
