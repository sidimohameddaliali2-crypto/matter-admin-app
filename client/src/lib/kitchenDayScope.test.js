import { currentKitchenMenu, kitchenToday, formatKitchenDay, visibleKitchenCustomer, kitchenCustomerDay } from './kitchenDayScope';

test('automatic menu selection uses today in Dubai and refuses expired, unpublished or ambiguous menus', () => {
  expect(kitchenToday(new Date('2026-10-27T21:30:00Z'))).toBe('2026-10-28');
  expect(formatKitchenDay('2026-10-28')).toBe('Wednesday, 28 October 2026');
  const active = { _id: 'active', isActive: true, isPublished: true, startDate: '2026-10-26', endDate: '2026-11-01' };
  const others = [{ ...active, _id: 'disabled', isActive: false }, { ...active, _id: 'draft', isPublished: false }, { ...active, _id: 'old', endDate: '2026-10-27' }];
  expect(currentKitchenMenu([...others, active], '2026-10-28').menu).toBe(active);
  expect(currentKitchenMenu([active, { ...active, _id: 'another' }], '2026-10-28')).toEqual({ menu: null, ambiguous: true });
});

test('a future selection alone cannot put a customer in today’s list, but an active delivery without choices remains visible', () => {
  const row = { matterCustomerId: 'permanent', selectedMeals: [{ date: '2026-10-30' }] };
  expect(visibleKitchenCustomer(row, [], '2026-10-28')).toBe(false);
  expect(visibleKitchenCustomer(row, [{ customer_id: 'permanent' }], '2026-10-28')).toBe(true);
  expect(visibleKitchenCustomer({ partner: 'p', selectedMeals: row.selectedMeals }, [], '2026-10-28')).toBe(false);
});

test('the day view removes other dates and their warnings without changing saved portions or macro values', () => {
  const today = { date: '2026-10-28', category: 'meal', quantity: 1, weight: 420, macros: { C: 35, P: 30, F: 15, calories: 395 }, _overrideKey: 'stable-key' };
  const tomorrow = { ...today, date: '2026-10-29', weight: 500, flags: { macroCapped: true } };
  const entry = { selectedMeals: [today, tomorrow], mealsByDay: [{ dateKey: today.date, meals: [today] }, { dateKey: tomorrow.date, meals: [tomorrow] }], totalWeight: 920, needsAttention: true };
  const before = JSON.stringify(entry), view = kitchenCustomerDay(entry, today.date);
  expect(view.selectedMeals).toEqual([today]);
  expect(view.totalWeight).toBe(420);
  expect(view.needsAttention).toBe(false);
  expect(view.selectedMeals[0]._overrideKey).toBe('stable-key');
  expect(JSON.stringify(entry)).toBe(before);
  expect(kitchenCustomerDay(entry, '2026-10-30').showMissingPlaceholder).toBe(true);
});
