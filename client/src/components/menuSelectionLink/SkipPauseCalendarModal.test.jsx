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
const day = (key) => container.querySelector('button[aria-label^="' + key + '"]');
const click = (element) => act(() => element.click());
const pauses = [
  { date: '2099-10-21' },
  { date: '2099-10-22' },
];

test('opens directly in multiple selection, requires all dates, and submits the displayed chronological pairs', () => {
  const onConfirm = jest.fn();
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled pauses={pauses}
    activeDeliveryDates={['2099-11-03']} onConfirm={onConfirm} />));
  expect(button('Show paused days')).toBeUndefined();
  expect(button('Show resume dates')).toBeUndefined();
  expect(button('Choose multiple resume dates')).toBeUndefined();
  expect(button('Change resume')).toBeUndefined();
  expect(button('Confirm').disabled).toBe(true);
  expect(day('2099-11-03').disabled).toBe(true);
  expect(day('2099-11-02').getAttribute('aria-pressed')).toBe('false');
  click(day('2099-11-06'));
  expect(button('Confirm').disabled).toBe(true);
  click(day('2099-11-04'));
  expect(button('Confirm').disabled).toBe(false);
  expect(day('2099-11-04').getAttribute('aria-pressed')).toBe('true');
  // A third date cannot exceed the number of skipped days.
  click(day('2099-11-08'));
  expect(container.textContent).toContain('2 of 2 resume dates selected');
  click(day('2099-11-04'));
  expect(button('Confirm').disabled).toBe(true);
  click(day('2099-11-05'));
  click(button('Confirm'));
  expect(onConfirm).toHaveBeenCalledWith([
    { date: '2099-10-21', action: 'pause', resumeDate: '2099-11-05', alreadyPaused: false },
    { date: '2099-10-22', action: 'pause', resumeDate: '2099-11-06', alreadyPaused: false },
  ]);
});

test('calendar opens at the last delivery month with no suggested or selected resume dates', () => {
  const render = (loading, rows) => act(() => root.render(<SkipPauseCalendarModal open loading={loading} weekendEnabled pauses={rows} activeDeliveryDates={['2099-11-03', '2099-10-23']} />));
  render(true, [{ date: '2099-10-21' }]);
  render(false, pauses);
  expect(container.textContent).toContain('November 2099');
  expect(container.textContent).toContain('Please select the resume date.');
  expect(container.textContent).not.toContain('Suggested');
  expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
  expect(button('Confirm').disabled).toBe(true);
  click(day('2099-11-02'));
  click(container.querySelector('[aria-label="Next month"]'));
  click(day('2099-12-01'));
  expect(button('Confirm').disabled).toBe(false);
  click(container.querySelector('[aria-label="Previous month"]'));
  expect(day('2099-11-02').getAttribute('aria-pressed')).toBe('true');
});

test('paused dates stay red and fixed even while Matter still lists them as active', () => {
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled pauses={pauses}
    activeDeliveryDates={['2099-10-21', '2099-10-22']} />));
  for (const key of ['2099-10-21', '2099-10-22']) {
    expect(day(key).disabled).toBe(true);
    expect(day(key).style.background).toBe('rgb(220, 38, 38)');
  }
});

test('free weekends remain selectable and availability errors block selection and confirmation', () => {
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled pauses={pauses} />));
  click(container.querySelector('[aria-label="Next month"]'));
  const weekend = [...container.querySelectorAll('button[aria-label^="2099-11-"]')].find((b) => {
    const weekday = new Date(b.getAttribute('aria-label').slice(0, 10) + 'T00:00:00').getDay();
    return weekday === 0 || weekday === 6;
  });
  expect(weekend.disabled).toBe(false);
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled pauses={pauses} availabilityError="Please retry" />));
  expect(day('2099-11-02').disabled).toBe(true);
  expect(button('Confirm').disabled).toBe(true);
  expect(container.querySelector('[role="alert"]').textContent).toBe('Please retry');
});

test('already paused days do not require selecting another replacement and failures stay visible', () => {
  act(() => root.render(<SkipPauseCalendarModal open weekendEnabled
    pauses={[{ ...pauses[0], alreadyPaused: true }, pauses[1]]}
    submissionError="One pause failed. Please retry." />));
  expect(container.textContent).toContain('0 of 1 resume dates selected');
  expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
  click(container.querySelector('[aria-label="Next month"]'));
  click(day('2099-11-04'));
  expect(button('Confirm').disabled).toBe(false);
  expect(container.querySelector('[role="alert"]').textContent).toContain('One pause failed');
});
