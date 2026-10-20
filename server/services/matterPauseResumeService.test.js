// Run with: npm test (node --test) from server/.
// Pure-fixture tests for the resume-date algorithm — no DB, no Matter API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestResumeDates } from './matterPauseResumeService.js';

test('one skip, clean subscription -> resumes the day after cycle end', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21'],
    cycleEndKey: '2026-10-25',
    existingPaused: new Set(),
    usedReturn: new Set(),
    weekendEnabled: true
  });
  assert.deepEqual(out.get('2026-10-21'), { alreadyPaused: false, resumeDate: '2026-10-26' });
});

test('multiple skips in one batch get sequential resume days, in order', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21', '2026-10-22', '2026-10-23'],
    cycleEndKey: '2026-10-25',
    existingPaused: new Set(),
    usedReturn: new Set(),
    weekendEnabled: true
  });
  assert.equal(out.get('2026-10-21').resumeDate, '2026-10-26');
  assert.equal(out.get('2026-10-22').resumeDate, '2026-10-27');
  assert.equal(out.get('2026-10-23').resumeDate, '2026-10-28');
});

test('weekends are skipped for a customer who does not take weekend deliveries', () => {
  // cycle ends Thursday 2026-10-22 -> first candidate Fri 10-23 is fine (not weekend),
  // so push the cycle end forward to land the first candidate ON a weekend.
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21'],
    cycleEndKey: '2026-10-23', // Friday -> first candidate Sat 10-24
    existingPaused: new Set(),
    usedReturn: new Set(),
    weekendEnabled: false
  });
  // Sat 10-24 and Sun 10-25 are skipped; lands on Mon 10-26.
  assert.equal(out.get('2026-10-21').resumeDate, '2026-10-26');
});

test('weekends are NOT skipped for a customer who does take weekend deliveries', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21'],
    cycleEndKey: '2026-10-23', // Friday -> first candidate Sat 10-24
    existingPaused: new Set(),
    usedReturn: new Set(),
    weekendEnabled: true
  });
  assert.equal(out.get('2026-10-21').resumeDate, '2026-10-24');
});

test('a date Matter already has paused is reported as already-paused, consuming no resume slot', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21', '2026-10-22'],
    cycleEndKey: '2026-10-25',
    existingPaused: new Set(['2026-10-21']),
    usedReturn: new Set(),
    weekendEnabled: true
  });
  assert.deepEqual(out.get('2026-10-21'), { alreadyPaused: true, resumeDate: null });
  // The second skip still gets the FIRST available resume slot — the
  // already-paused date didn't consume one.
  assert.equal(out.get('2026-10-22').resumeDate, '2026-10-26');
});

test('a resume day Matter already has booked (usedReturn) is skipped over', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21'],
    cycleEndKey: '2026-10-25',
    existingPaused: new Set(),
    usedReturn: new Set(['2026-10-26']),
    weekendEnabled: true
  });
  assert.equal(out.get('2026-10-21').resumeDate, '2026-10-27');
});

test('no cycle_end_date -> every date reported with a null resume date, no crash', () => {
  const out = suggestResumeDates({
    skippedDateKeys: ['2026-10-21', '2026-10-22'],
    cycleEndKey: null,
    existingPaused: new Set(),
    usedReturn: new Set(),
    weekendEnabled: true
  });
  assert.deepEqual(out.get('2026-10-21'), { alreadyPaused: false, resumeDate: null });
  assert.deepEqual(out.get('2026-10-22'), { alreadyPaused: false, resumeDate: null });
});
