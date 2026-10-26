import test from 'node:test';
import assert from 'node:assert/strict';
import { lockCutoff, isInLockWindow } from '../models/SpaceOrder.js';

const deadlines = [
  ['2026-10-26', '2026-10-23T11:00:59.999Z'],
  ['2026-10-27', '2026-10-24T20:00:59.999Z'],
  ['2026-10-28', '2026-10-25T20:00:59.999Z'],
  ['2026-10-29', '2026-10-26T20:00:59.999Z'],
  ['2026-10-30', '2026-10-27T20:00:59.999Z'],
  ['2026-10-31', '2026-10-27T20:00:59.999Z'],
  ['2026-11-01', '2026-10-27T20:00:59.999Z'],
];
for (const [date, expected] of deadlines) {
  test(`${date}: cutoff is Dubai time and the full cutoff minute stays open`, () => {
    assert.equal(lockCutoff(date).toISOString(), expected);
    assert.equal(isInLockWindow(date, new Date(expected)), false);
    assert.equal(isInLockWindow(new Date(`${date}T00:00:00Z`), new Date(Date.parse(expected) + 1)), true);
    assert.equal(isInLockWindow(date, new Date(Date.parse(expected) - 1)), false);
  });
}
