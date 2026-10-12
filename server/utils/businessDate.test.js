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
