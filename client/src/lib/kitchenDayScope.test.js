import { currentKitchenMenu, kitchenMenuAccess, kitchenToday, formatKitchenDay, visibleKitchenCustomer, kitchenCustomerDay } from './kitchenDayScope';

const current = { _id: 'current', isActive: true, isPublished: true, startDate: '2026-10-26', endDate: '2026-11-01' };
const scheduled = { ...current, _id: 'scheduled', isPublished: false, startDate: '2026-11-02', endDate: '2026-11-08' };
test.each(['2026-10-29T18:00:00Z', '2026-10-30T10:59:59.999Z'])('scheduled menu stays hidden before Friday 15:00 Dubai: %s', now => {
  expect(kitchenMenuAccess([current, scheduled], new Date(now)).availableMenus).toEqual([current]);
});
test.each(['2026-10-30T11:00:00Z', '2026-10-31T12:00:00Z', '2026-11-01T19:59:59.999Z'])('active and next scheduled menu are available through the weekend: %s', now => {
  const access = kitchenMenuAccess([current, scheduled, { ...scheduled, _id: 'stopped', isActive: false }, { ...scheduled, _id: 'later', startDate: '2026-11-09' }], new Date(now));
  expect(access.availableMenus).toEqual([current, scheduled]);
  expect(access.defaultMenu).toBe(current);
});
test('a new Dubai week removes the old menu and waits until Friday to open the following week', () => {
  const published = { ...scheduled, isPublished: true };
  const later = { ...scheduled, _id: 'later', startDate: '2026-11-09', endDate: '2026-11-15' };
  expect(kitchenMenuAccess([current, published, later], new Date('2026-11-01T20:00:00Z')).availableMenus).toEqual([published]);
  expect(kitchenMenuAccess([current, published, later], new Date('2026-11-06T11:00:00Z')).availableMenus).toEqual([published, later]);
});
test('overlapping scheduled menus are not guessed or offered', () => {
  const access = kitchenMenuAccess([current, scheduled, { ...scheduled, _id: 'duplicate' }], new Date('2026-10-30T11:00:00Z'));
  expect(access.scheduledAmbiguous).toBe(true);
  expect(access.availableMenus).toEqual([current]);
});

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
