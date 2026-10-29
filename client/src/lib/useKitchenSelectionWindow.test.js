import { kitchenSelectionWindow } from './useKitchenSelectionWindow';

test('Monday cutoff uses Dubai time, includes the full minute and respects menu policy', () => {
  const cutoff = '2026-10-23T11:00:59.999Z';
  expect(kitchenSelectionWindow({}, '2026-10-26', cutoff)).toMatchObject({ canAutoAssign: false, deadlineAt: cutoff });
  expect(kitchenSelectionWindow({}, '2026-10-26', '2026-10-23T11:01:00Z').canAutoAssign).toBe(true);
  expect(kitchenSelectionWindow({ selectionDeadlines: [{ deliveryDay: 'Monday', daysBefore: 0, deadlineTime: '18:30' }] }, '2026-10-26', cutoff).deadlineAt).toBe('2026-10-26T14:30:59.999Z');
});

test('missing scopes or invalid rules never enable auto assignment', () => {
  expect(kitchenSelectionWindow(null, '').canAutoAssign).toBe(false);
  expect(kitchenSelectionWindow({}, '2026-02-30').canAutoAssign).toBe(false);
  expect(kitchenSelectionWindow({ selectionDeadlines: [{ deliveryDay: 'Tuesday' }] }, '2026-10-26').canAutoAssign).toBe(false);
});
