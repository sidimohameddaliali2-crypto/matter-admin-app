import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import SkipPauseCalendarModal from './SkipPauseCalendarModal';

global.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (label) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
const day = (key) => container.querySelector(`button[aria-label^="${key}"]`);
const click = (element) => act(() => element.click());
const pauses = [{ date: '2099-10-21', suggestedResumeDate: '2099-11-02' }];

test('loads the suggested resume month after an asynchronous preview and submits the edited date with the fixed pause', () => {
  const onConfirm = jest.fn();
  const render = (loading, rows) => act(() => root.render(
    <SkipPauseCalendarModal open loading={loading} pauses={rows} onConfirm={onConfirm} weekendEnabled />
  ));
  render(true, [{ date: '2099-10-21' }]);
  render(false, pauses);
  expect(container.textContent).toContain('November 2099');
  expect(day('2099-11-02').getAttribute('aria-pressed')).toBe('false');
  expect(button('Confirm').disabled).toBe(true);
  expect(button('Unpause')).toBeUndefined();
  click(day('2099-11-05'));
  // Moving a date later must still allow returning to the original suggestion.
  expect(day('2099-11-02').disabled).toBe(false);
  click(day('2099-11-02'));
  click(button('Confirm'));
  expect(onConfirm).toHaveBeenCalledWith([
    { date: '2099-10-21', resumeDate: '2099-11-02', action: 'pause', alreadyPaused: false },
  ]);
  click(container.querySelector('[aria-label="Previous month"]'));
  expect(day('2099-10-21').disabled).toBe(true);
});

test('prevents two skips from using the same resume date and switches the calendar to the selected row', () => {
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled pauses={[
    ...pauses, { date: '2099-10-22', suggestedResumeDate: '2099-12-01' },
  ]} />));
  click(day('2099-11-02'));
  expect(button('Confirm').disabled).toBe(true);
  click(button('Change resume'));
  expect(day('2099-12-01').disabled).toBe(false);
  expect(day('2099-12-01').getAttribute('aria-pressed')).toBe('false');
  click(day('2099-12-01'));
  expect(day('2099-12-01').getAttribute('aria-pressed')).toBe('true');
  expect(button('Confirm').disabled).toBe(false);
  click(container.querySelector('[aria-label="Previous month"]'));
  expect(day('2099-11-02').disabled).toBe(true);
});

test('requires a resume date when the preview cannot suggest one', () => {
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled pauses={[{ date: '2099-10-21' }]} />));
  expect(button('Confirm').disabled).toBe(true);
  expect(day('2099-10-21').disabled).toBe(true);
  click(day('2099-10-23'));
  expect(button('Confirm').disabled).toBe(false);
});

test('chooses several resume dates together, blocks active deliveries, and keeps pauses red and fixed', () => {
  const onConfirm = jest.fn();
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled onConfirm={onConfirm}
    activeDeliveryDates={['2099-11-03']} pauses={[
      ...pauses, { date: '2099-10-22', suggestedResumeDate: '2099-11-04' },
    ]} />));
  click(button('Choose multiple resume dates'));
  expect(button('Confirm').disabled).toBe(true);
  expect(day('2099-11-03').disabled).toBe(true);
  click(day('2099-11-04'));
  click(day('2099-11-06'));
  expect(button('Confirm').disabled).toBe(false);
  click(day('2099-11-04'));
  expect(button('Confirm').disabled).toBe(true);
  click(day('2099-11-05'));
  click(button('Confirm'));
  expect(onConfirm).toHaveBeenCalledWith([
    { date: '2099-10-21', resumeDate: '2099-11-05', action: 'pause', alreadyPaused: false },
    { date: '2099-10-22', resumeDate: '2099-11-06', action: 'pause', alreadyPaused: false },
  ]);
  click(container.querySelector('[aria-label="Previous month"]'));
  expect(day('2099-10-21').disabled).toBe(true);
  expect(day('2099-10-21').style.background).toBe('rgb(220, 38, 38)');
});

test('cannot confirm or edit when Matter availability could not be verified', () => {
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled pauses={pauses} availabilityError="Please retry" />));
  expect(button('Confirm').disabled).toBe(true);
  expect(day('2099-11-05').disabled).toBe(true);
  expect(container.querySelector('[role="alert"]').textContent).toBe('Please retry');
});

test('Matter weekend eligibility allows free weekend resume dates and shows partial pause failures', () => {
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled pauses={pauses} submissionError="One pause failed. Please retry." />));
  const weekend = [...container.querySelectorAll('button[aria-label^="2099-11-"]')].find((b) => {
    const weekday = new Date(`${b.getAttribute('aria-label').slice(0, 10)}T00:00:00`).getDay();
    return weekday === 0 || weekday === 6;
  });
  expect(weekend.disabled).toBe(false);
  expect(container.querySelector('[role="alert"]').textContent).toBe('One pause failed. Please retry.');
});

test('all three unconfirmed skips stay visible when the suggested resumes are in another month', () => {
  const onConfirm = jest.fn();
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled onConfirm={onConfirm}
    pauses={[
      { date: '2026-10-28', suggestedResumeDate: '2026-11-12' },
      { date: '2026-10-30', suggestedResumeDate: '2026-11-13' },
      { date: '2026-10-31', suggestedResumeDate: '2026-11-14' },
    ]} activeDeliveryDates={['2026-10-28', '2026-10-30', '2026-10-31']} />));
  expect(container.textContent).toContain('3 paused days listed below');
  click(button('Show paused days'));
  for (const date of ['2026-10-28', '2026-10-30', '2026-10-31']) {
    expect(day(date).style.background).toBe('rgb(220, 38, 38)');
    expect(day(date).disabled).toBe(true);
  }
  click(button('Show resume dates'));
  expect(container.textContent).toContain('November 2026');
  expect(onConfirm).not.toHaveBeenCalled();
});
