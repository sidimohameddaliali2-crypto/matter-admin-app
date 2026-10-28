import { copyManagedMenuItem, managedMenuPayload } from './managedMenuItems';

test('copying a dish or day creates independent items without claiming the original ID', () => {
  const item = { menuItemId: 'selected-dish', _id: 'selected-dish', mealName: 'Chicken', carbIngredients: [{ name: 'Rice', visible: true }] };
  const copied = copyManagedMenuItem(item);
  expect(copied.menuItemId).toBeUndefined();
  expect(copied._id).toBeUndefined();
  copied.carbIngredients[0].name = 'Potato';
  expect(item.carbIngredients[0].name).toBe('Rice');
});

test('publish is included in the same payload as edited dishes and preserves item IDs', () => {
  const days = [{ date: '2026-10-30', items: [{ menuItemId: 'unchanged', mealName: 'Chicken' }] }];
  const payload = managedMenuPayload({ title: 'Menu' }, days, true);
  expect(payload).toMatchObject({ title: 'Menu', days, isPublished: true });
  expect(managedMenuPayload({ title: 'Menu' }, days, false)).not.toHaveProperty('isPublished');
});
